# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a breaking change and is
recorded here.

## [Unreleased]

### Added

- `lintEventRegistry` reads a directory of event declarations and checks names, owners, version
  sequences, payload schemas and the compatibility of each version against the one before it.
- `event-schema-registry-linter` command line interface with `--registry`, `--mode`, `--config`,
  `--json`, `--help` and the seven documented limit flags.
- Four compatibility modes defined by the direction the contract moves in: `backward` refuses
  restrictive changes, `forward` refuses expansive ones, `full` refuses both, `none` refuses
  neither and records every change as information. There is no default mode; a run that names none
  is a configuration error.
- A per-event `compatibility` key that overrides the run mode for that event, recorded on every
  finding it decides.
- Documentation keywords (`title`, `description`, `examples`, `$comment`) as a frozen list. A change
  confined to them is `documentation-changed` at `info` in every mode, including `full`.
- Breakage reported as producer and consumer candidates, drawn from each event's declared
  `producers` and `consumers`, with the registry's limits stated rather than implied.
- Thirty-seven rules with severities pinned in one frozen table, documented in
  `docs/rule-catalog.md`, and driven through the real entry point one rule at a time.
- Seven explicit limits — `maxDepth`, `maxEvents`, `maxFields`, `maxFileBytes`, `maxSchemaDepth`,
  `maxVersions`, `timeoutMs` — each enforced, each named in the finding when it is reached, and
  each producing an `incomplete` report rather than a quietly shorter answer.
- A configuration file read through the same strict UTF-8 decoder as every event document, with
  unknown keys and unknown limits refused rather than ignored.
- Stable output: no clock reading, no locale, no absolute path and no filesystem enumeration order
  reaches stdout, so the same registry always produces byte-identical output.

### Notes on the design

- **Modes are named after the direction of the change, not after a reader/writer pairing.** The
  Avro and Confluent literature attaches `backward` and `forward` to which schema is reading whose
  data, and the labels land differently there. `docs/rule-catalog.md` states the direction of every
  rule so the word never has to be guessed at.
- **Unknown schema keywords are refused rather than ignored.** Most validators skip a keyword they
  do not recognise, which is how a misspelled `requried` silently drops a requirement. The same
  reasoning refuses an unknown key in an event document, a version entry and the configuration
  file.
- **`incomplete` outranks `fail`.** A run that could not read part of its input exits 2 even when
  it also found real errors, because a consumer needs to know the answer was partial.

No release has been published.
