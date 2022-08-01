# event-schema-registry-linter

Lint a directory of event declarations — names, owners, version sequences and versioned payload
schemas — and check every version against the one before it under an **explicitly chosen**
compatibility mode. Where a change breaks the mode, the report names the producers and consumers
most likely to notice first, as *candidates*.

- **Repository:** [edilec/event-schema-registry-linter](https://github.com/edilec/event-schema-registry-linter)
- **Area:** Automation & Workflows
- **License:** MIT

No runtime dependencies, no dev dependencies, Node built-ins only. Nothing is fetched and nothing
under the registry root is written.

## Install and run

```sh
npx event-schema-registry-linter --registry ./events --mode backward
```

```sh
# the machine-readable report, and nothing else, on stdout
event-schema-registry-linter --registry ./events --mode full --json > report.json
```

```js
import { lintEventRegistry, formatReport } from 'event-schema-registry-linter'

const report = await lintEventRegistry({ registry: './events', mode: 'backward' })
process.stdout.write(formatReport(report))
```

## What a registry looks like

Every `*.json` file under the root is one event declaration.

```json
{
  "name": "orders.order_placed",
  "owner": "team-orders",
  "producers": ["checkout-api"],
  "consumers": ["billing-worker", "search-indexer"],
  "versions": [
    {
      "version": 1,
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["order_id", "currency"],
        "properties": {
          "order_id": { "type": "string" },
          "currency": { "type": "string", "description": "ISO 4217 code." }
        }
      }
    },
    { "version": 2, "schema": { "type": "object" } }
  ]
}
```

`docs/rule-catalog.md` is the reference for the format, the supported schema subset, every rule and
every limit. `examples/registry` passes; `examples/registry-broken` does not.

## The mode is explicit, and it decides the verdict

Modes are named after the **direction the contract moves in**:

| Mode | Refuses | Examples |
| --- | --- | --- |
| `backward` | restrictive changes | a required field removed or made optional, a type narrowed to a strict subset, extra properties no longer allowed |
| `forward` | expansive changes | a required field added, an optional field made required, a type widened to a strict superset |
| `full` | both | |
| `none` | neither | every change is recorded as information |

There is no default. A run that names no direction exits 2 with an empty stdout, because
"compatible" has no meaning until the direction is named. An event may override the run mode with
its own `compatibility` key.

A change the active mode does not refuse is still reported — as `change-outside-mode` at `info`,
with a message naming the kind and the mode that *would* refuse it. Nothing is silently dropped.

**Documentation edits fail nothing.** `title`, `description`, `examples` and `$comment` are a
frozen list. A change confined to them is `documentation-changed` at `info` in every mode,
including `full`.

```
ERROR   orders/order-placed.json/versions/1/schema/properties/currency required-field-removed
        v1 -> v2: currency was removed; the earlier version declared it string.
        This is a restrictive change and backward compatibility refuses it.
```

## Producer and consumer breakage candidates

Each refused change carries the side most likely to notice it and the services declared on that
side:

```json
"breakage": { "side": "consumer", "refused": true, "candidates": ["billing-worker"] }
```

They are **candidates**, not a verdict. This tool reads a registry of declarations; it has no view
of a broker, a consumer group or a single live payload. A service consuming the event without
declaring itself is invisible here.

## Exit codes and streams

stdout carries the report and nothing else; stderr carries diagnostics.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| 0 | the registry was read and the mode was satisfied | the report |
| 1 | the registry was read and the mode was not satisfied | the report |
| 2 | invalid usage or configuration | **empty** |
| 2 | evidence missing, undecodable or bounded out | an `incomplete` report |

A consumer piping stdout must handle an empty stdout on exit 2. A configuration error means the run
never had a subject, so there is nothing to report about; an unreadable input means the run had a
subject and failed to obtain evidence about it, which is exactly what `incomplete` exists to say.

An `incomplete` run outranks a `fail`. Unknown evidence is never a pass.

## Configuration

```json
{
  "schemaVersion": "1",
  "mode": "backward",
  "owners": ["team-orders", "team-billing"],
  "limits": { "maxEvents": 100, "maxVersions": 20 }
}
```

Passed with `--config FILE`. It is decoded with the same strict UTF-8 decoder as every event
document, and every key it does not know is refused: accepting `maxEvent` beside `maxEvents` would
leave the real limit at its default while the operator believed otherwise. `--mode` overrides the
configured mode and says so on stderr.

## Limits

`maxDepth` 8, `maxEvents` 500, `maxFields` 500, `maxFileBytes` 262144, `maxSchemaDepth` 12,
`maxVersions` 50, `timeoutMs` 10000. Each has a command-line flag. Exceeding one produces an
`incomplete` report with a finding naming the limit — never a quietly shorter answer.

## Determinism

Findings sort by `(location.file, location.pointer, ruleId, message)`, compared by UTF-16 code
unit. No wall-clock reading, no locale, no hash-map iteration order and no filesystem enumeration
order reaches stdout. The same registry always produces byte-identical output. The only clock read
is the monotonic one enforcing `timeoutMs`; it is injectable and never reaches output.

## Limits and non-goals

This tool reads declarations. It is worth being precise about what that means it **cannot**
conclude:

- **It cannot tell you that anything actually broke.** It never contacts a broker, a schema
  registry API, a consumer group or a running service, and it never sees a payload. Every breakage
  it reports is a candidate derived from what the registry says.
- **It cannot see an undeclared consumer or producer.** A service reading the topic without an
  entry in `consumers` will not appear in any candidate list, and a registry with no `consumers` at
  all produces a `consumers-missing` warning rather than a confident empty answer.
- **It does not validate payloads against schemas.** No instance is checked.
- **It compares a deliberately small schema subset.** `type`, `properties`, `required`,
  `additionalProperties`, `items` and the four documentation keywords. `enum`, `format`, `pattern`,
  numeric bounds, `oneOf`, `anyOf`, `allOf`, `$ref` and `patternProperties` are refused as unknown
  keywords rather than compared on whatever remains — an enum member added or removed is a real
  compatibility change this tool will not judge for you.
- **It cannot see a semantic change inside an unchanged shape.** A field that keeps its name and
  type while changing from cents to pounds, or from UTC to local time, looks identical here. So
  does a renamed field, which is reported as one removal and one addition rather than a rename.
- **It cannot tell an honest documentation edit from a dishonest one.** A `description` rewritten to
  describe different behaviour is `info`, the same as one that clarifies the same behaviour. That
  is the deliberate trade: a documentation edit must never fail a build.
- **It does not know which versions are live.** Every declared version is compared with its
  predecessor, including versions no producer ever emitted and versions every consumer has left
  behind.
- **It cannot confirm that an owner is real.** `owner` is a string; `owners` in the configuration is
  an allowlist of strings. Neither is checked against a directory of teams.
- **It is not a security control.** It refuses paths that resolve outside the registry root and it
  strips control and bidi characters from everything it prints, because a linter must not become
  the thing that leaks or forges. Neither makes an untrusted registry safe to act on.
- **Two field names that differ only in characters the sanitiser strips collapse to one path** in
  the comparison, so a change between them is not reported.

## Development

```sh
npm run check     # lint, test, example, pack:check
npm run lint      # node --check over every source and test file
npm test          # node --test
npm run example   # lint examples/registry with examples/linter.config.json
```

Every guarantee stated above has a test that fails when the guarantee is removed. Severity is
pinned by driving each rule through the real entry point and asserting the process exit code, not
by comparing a table against a document; ordering is pinned with inputs whose code-unit order and
collation order genuinely disagree; sanitising is pinned with each character class arriving through
an identifier as well as an excerpt.

## License

MIT. See [LICENSE](./LICENSE).
