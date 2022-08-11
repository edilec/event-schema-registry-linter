# Rule catalog, compatibility model and limits

This document is the reference for what `event-schema-registry-linter` checks, what each rule
means, and what it deliberately cannot tell you. The rule ids below are part of the public
interface: renaming or removing one is a breaking change and is recorded in the changelog.

The severity table in `src/index.mjs` is the source of truth for severity, and
`test/severity-table.test.mjs` asserts this document against it in both directions. That test is a
documentation check, **not** the severity guard: three declarations agreeing with each other are
satisfied by one coordinated edit. The guard is `test/severity-outcomes.test.mjs`, which drives
every rule below through the real entry point and asserts the status, the error count, the printed
severity word and the process exit code -- each one written out as a literal at the assertion, so
that editing this table and that table together has nothing there to agree with.

## The registry format

A registry is a directory. Every `*.json` file under it, to a bounded depth, is one event
declaration. Nothing else in the tree is read.

```json
{
  "name": "orders.order_placed",
  "owner": "team-orders",
  "description": "Emitted once a customer order has been accepted for fulfilment.",
  "compatibility": "backward",
  "producers": ["checkout-api"],
  "consumers": ["billing-worker", "search-indexer"],
  "versions": [
    { "version": 1, "description": "First published contract.", "schema": { "type": "object" } },
    { "version": 2, "schema": { "type": "object" } }
  ]
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | `domain.event_name`: lower-case segments joined by dots, words inside a segment joined by single underscores, at least one dot, at most 120 characters. |
| `owner` | yes | The team or rota answerable for this contract. Every event needs one. |
| `description` | no | Free text about the event. Not compared. |
| `compatibility` | no | `backward`, `forward`, `full` or `none` for this event, overriding the run mode. |
| `producers` | no, but warned | Services that declare they emit this event. |
| `consumers` | no, but warned | Services that declare they read it. |
| `versions` | yes | One entry per version, listed from 1 with no gaps: `version`, `schema`, optional `description`. |

Any other key is refused. `consumer` next to `consumers` would silently empty the list this tool
names breakage candidates from, and a one-character typo must not quieten a run.

## The payload schema subset

A `schema` is a JSON Schema fragment restricted to the keywords that can be compared without
guessing:

| Keyword | Meaning |
| --- | --- |
| `type` | Required. One of `array`, `boolean`, `integer`, `null`, `number`, `object`, `string`, or a non-empty array of them. |
| `properties` | Object nodes only. A map of property name to schema node. |
| `required` | Object nodes only. Property names that must be present; each must be declared in `properties`. |
| `additionalProperties` | Object nodes only, boolean. Absent means `true`, as in JSON Schema. |
| `items` | Array nodes only. The schema node every item satisfies. |
| `title`, `description`, `examples`, `$comment` | Documentation. Never contract. |

Any other keyword is refused as `schema-unknown-keyword`. Most validators ignore a keyword they do
not recognise, which is exactly how a misspelled `requried` drops a requirement without anybody
noticing.

`integer` is treated as a strict subtype of `number`: a field declared `number` covers `integer`
too, so `number` to `integer` is a narrowing rather than an unrelated change.

## Compatibility modes

Modes are defined by the **direction the contract moves in**, which is the definition that stays
self-consistent once both halves of a rollout are considered:

- A **restrictive** change takes something away or tightens what is permitted: a required field
  disappears or stops being required, a type narrows to a strict subset, extra properties stop
  being allowed.
- An **expansive** change adds a demand or broadens what is emitted: a new required field appears,
  an optional field becomes required, a type widens to a strict superset.

| Mode | Refuses |
| --- | --- |
| `backward` | restrictive changes |
| `forward` | expansive changes |
| `full` | both |
| `none` | neither; every change is recorded as information |

There is no default. A run that does not name a direction is a configuration error, because
"compatible" has no meaning until the direction is named.

A change the active mode does not refuse is still reported, as `change-outside-mode` at `info`,
with a message naming the kind and the mode that would refuse it. Nothing is silently dropped.

**A note on the words.** The Avro and Confluent literature attaches `backward` and `forward` to
reader/writer pairings rather than to the direction of the edit, and the labels land differently
there. Read the direction column below, not the word.

## Breakage candidates

A refused change is reported with the side most likely to notice it first and the services that
declared themselves on that side:

```json
"breakage": { "side": "consumer", "refused": true, "candidates": ["billing-worker"] }
```

They are **candidates**. This registry knows what services declared, never what is on the wire. An
empty candidate list means the registry never recorded anyone on that side, not that nobody breaks;
`consumers-missing` and `producers-missing` say so explicitly.

## Comparison scope

Each version is compared with the one immediately before it. Three versions make two pairs. A field
that disappears takes its subtree with it, and one finding per removed descendant would bury the
line a reviewer needs, so descendants of a removed or added path are folded into the parent's
finding.

## Rules

| Rule id | Severity | Marks the run incomplete | Direction | Breakage side | What it means |
| --- | --- | --- | --- | --- | --- |
| `additional-properties-relaxed` | warning | no | expansive | consumer | A node that refused unknown properties now allows them, so a strict consumer of the earlier version rejects payloads the later one permits. |
| `additional-properties-restricted` | error | no | restrictive | producer | A node that allowed unknown properties now refuses them, so a producer still emitting the earlier version has its payload rejected. |
| `change-outside-mode` | info | no | - | - | A real change was detected, and the active mode does not refuse changes in that direction. The message names the kind and the mode that would refuse it. |
| `consumers-missing` | warning | no | - | - | The event declares no consumers, so this registry cannot name a consumer breakage candidate for it. |
| `directory-too-deep` | error | yes | - | - | A directory sits below the `maxDepth` limit and was not read. |
| `documentation-changed` | info | no | documentation | - | Only `title`, `description`, `examples` or `$comment` differ at this node. A documentation edit breaks nothing in any mode. |
| `event-malformed` | error | no | - | - | A declared value has the wrong JSON shape: a version entry that is not an object, a non-array `producers`, an unknown `compatibility`. |
| `event-name-duplicate` | error | no | - | - | Two files declare the same event name, so the registry answer depends on which file a reader opened. |
| `event-name-invalid` | error | no | - | - | The name is missing, too long, or not `domain.event_name` in lower case. |
| `event-not-json` | error | yes | - | - | The file decoded as UTF-8 but did not parse as JSON, so it was not read. |
| `event-not-utf8` | error | yes | - | - | The file is not valid UTF-8. It is not decoded leniently and it is not guessed at. |
| `event-too-large` | error | yes | - | - | The file is larger than the `maxFileBytes` limit and was not read. |
| `event-unknown-key` | error | no | - | - | An event document or a version entry carries a key this format does not define, most often a typo that would silently drop what it meant to declare. |
| `event-unreadable` | error | yes | - | - | A file or directory under the root could not be listed, inspected or read. |
| `field-type-narrowed` | error | no | restrictive | producer | The later version accepts a strict subset of the earlier type set, so a producer on the earlier version can emit a value the later schema rejects. |
| `field-type-widened` | error | no | expansive | consumer | The later version accepts a strict superset, so a consumer validating against the earlier version rejects the added members. |
| `no-events-found` | warning | yes | - | - | No `*.json` declaration was found under the root. A run with nothing to check is not a run that passed. |
| `optional-field-added` | info | no | neutral | - | An optional field appeared. This breaks nothing in any mode. |
| `optional-field-made-required` | error | no | expansive | producer | A field that could be omitted must now be present, so a producer on the earlier version emits payloads the later schema rejects. |
| `optional-field-removed` | warning | no | restrictive | consumer | An optional field disappeared. A consumer that read it defensively still works, so this is a warning rather than an error. |
| `owner-missing` | error | no | - | - | The event declares no owner. Every event needs a team or rota answerable for its contract. |
| `owner-unknown` | error | no | - | - | The owner is not one of the owners this run accepts, which is only checked when `owners` is configured. |
| `path-escapes-root` | error | yes | - | - | A file or directory inside the root resolves, by real path, outside it. It was not read and its content was not echoed. |
| `producers-missing` | warning | no | - | - | The event declares no producers, so this registry cannot name a producer breakage candidate for it. |
| `required-field-added` | error | no | expansive | producer | The later version requires a field the earlier one never carried, so a producer still on the earlier version cannot supply it. |
| `required-field-made-optional` | error | no | restrictive | consumer | A field that was always present may now be absent, so a consumer of the earlier version loses a guarantee it was given. |
| `required-field-removed` | error | no | restrictive | consumer | A field the earlier version required is gone, so a consumer of the earlier version reads a field that no longer arrives. |
| `schema-invalid` | error | no | - | - | A schema node is malformed: no type, an unsupported type, `required` naming a property that is not declared, `items` on a node that is not an array. |
| `schema-too-deep` | error | yes | - | - | A payload schema nests below the `maxSchemaDepth` limit; the rest of it was not read. |
| `schema-unknown-keyword` | error | no | - | - | A schema node carries a keyword this subset does not define. Most validators ignore an unknown keyword, which is how a misspelled `required` silently drops a requirement. |
| `time-budget-exceeded` | error | yes | - | - | Reading the registry passed the `timeoutMs` budget; part of the tree was not read. |
| `too-many-events` | error | yes | - | - | The registry holds more declaration files than the `maxEvents` limit; the rest were not read. |
| `too-many-fields` | error | yes | - | - | One payload schema declares more fields than the `maxFields` limit; the rest of it was not read. |
| `too-many-versions` | error | yes | - | - | One event declares more versions than the `maxVersions` limit; none of them were compared. |
| `version-duplicate` | error | no | - | - | The same version number is declared more than once. |
| `version-sequence-invalid` | error | no | - | - | Versions are not a contiguous run of integers from 1 in listed order. |
| `versions-missing` | error | no | - | - | The event declares no version, so there is no payload contract to check. |

## Limits

Every limit is explicit, overridable, and named in the finding when it is reached. Exceeding one
produces an `incomplete` report -- never a quietly shorter answer and never a pass.

| Limit | Flag | Default | Floor | What it bounds |
| --- | --- | ---: | ---: | --- |
| `maxDepth` | `--max-depth` | 8 | 1 | Directory depth below the registry root. |
| `maxEvents` | `--max-events` | 500 | 1 | Declaration files read. |
| `maxFields` | `--max-fields` | 500 | 1 | Declared fields per payload schema. |
| `maxFileBytes` | `--max-file-bytes` | 262144 | 1 | Bytes per declaration file. |
| `maxSchemaDepth` | `--max-schema-depth` | 12 | 1 | Nesting depth of a payload schema. |
| `maxVersions` | `--max-versions` | 50 | 1 | Versions per event. |
| `timeoutMs` | `--timeout-ms` | 10000 | 0 | Time budget for reading the registry. |

`timeoutMs` is the one limit that accepts 0. The budget is checked after each directory entry
rather than before it, so a walk always attempts at least one entry and a budget of zero stops
after the first -- which is the only way to prove from outside the process that the flag reaches
the walk at all. Bounding the size of any single file is `maxFileBytes`' job, not the clock's.

## Exit codes and streams

| Situation | stdout | stderr | status | exit |
| --- | --- | --- | --- | ---: |
| The registry was read and the mode was satisfied | the report | diagnostics | `pass` | 0 |
| The registry was read and the mode was not satisfied | the report | diagnostics | `fail` | 1 |
| Invalid usage or configuration | **empty** | the message | no report | 2 |
| Evidence missing, undecodable or bounded out | the report | diagnostics | `incomplete` | 2 |

An `incomplete` run outranks a `fail`: a verdict about inputs that were never read would be worse
than saying nothing about them.

## Determinism

Findings sort by `(location.file, location.pointer, ruleId, message)`, compared by UTF-16 code
unit. No wall-clock reading, no locale, no hash-map iteration order and no filesystem enumeration
order reaches stdout, so the same registry always produces byte-identical output. The only clock
the tool reads is the monotonic one that enforces `timeoutMs`, and it is injectable and never
reaches output.

## What this tool cannot conclude

- **Whether anything actually breaks.** It reads declarations. It does not read a broker, a
  consumer group, a schema registry API or a single live payload.
- **Whether the declared producers and consumers are the real ones.** A service that consumes an
  event without declaring it is invisible here, and will not appear as a candidate.
- **Whether a payload conforms to its schema.** No instance validation is performed.
- **Whether an `enum`, a `format`, a `pattern`, a numeric bound, `oneOf`, `anyOf`, `allOf`, `$ref`
  or `patternProperties` changed.** They are not in the supported subset and a schema carrying one
  is refused rather than compared on the keywords that remain.
- **Whether a semantic change hid inside an unchanged shape.** A field that keeps its name and type
  but changes meaning -- cents to pounds, UTC to local -- is invisible to a structural comparison.
  So is a renamed field, which is reported as one removal and one addition.
- **Whether a documentation edit was honest.** A `description` rewritten to describe different
  behaviour reads exactly like one that clarifies the same behaviour.
- **Whether a version that was never published matters.** Every declared version is compared with
  its predecessor, including versions no producer ever emitted.
- **Anything about a field name that differs only in characters the sanitiser strips.** Two names
  that differ only in a control or bidi character collapse to one path in the comparison.
