#!/usr/bin/env node

import { formatReport, lintEventRegistry, loadConfigFile } from '../src/index.mjs'

const HELP = `event-schema-registry-linter

Lint a directory of event declarations: names, owners, version sequences and
payload schemas, and check each version against the one before it under an
explicitly chosen compatibility mode. Nothing is fetched and nothing is written.

Usage:
  event-schema-registry-linter --registry DIR --mode MODE [--config FILE]
                               [--json] [limits]

Options:
  --registry DIR         Directory of *.json event declarations (required)
  --mode MODE            backward | forward | full | none (required unless the
                         configuration file supplies it)
  --config FILE          JSON configuration: mode, owners, limits
  --json                 Emit the machine-readable report on stdout
  --max-depth N          Maximum directory depth below the root (default 8)
  --max-events N         Maximum event files read (default 500)
  --max-fields N         Maximum fields per payload schema (default 500)
  --max-file-bytes N     Maximum bytes per event file (default 262144)
  --max-schema-depth N   Maximum payload schema nesting (default 12)
  --max-versions N       Maximum versions per event (default 50)
  --timeout-ms N         Time budget for reading the registry (default 10000;
                         0 leaves no time at all and is only useful for
                         proving the budget is enforced)
  -h, --help             Show this help

Compatibility modes are defined by the direction the contract moves in:

  backward  refuses restrictive changes  - a required field removed or made
            optional, a type narrowed to a strict subset, extra properties
            no longer allowed
  forward   refuses expansive changes    - a required field added, an optional
            field made required, a type widened to a strict superset
  full      refuses both
  none      refuses neither and records every change as information

There is no default mode. "Compatible" has no meaning until the direction is
named, so a run that names none is a configuration error rather than a guess.

A change confined to title, description, examples or $comment is a
documentation edit. It is reported as information and fails no mode, including
full.

Breakage is reported as producer and consumer **candidates**, drawn from the
producers and consumers each event declares. This registry knows declarations,
not live traffic: it cannot tell you who is actually reading the topic.

Every option is accepted once; a repeated flag is a configuration error rather
than a silent last-wins. An unknown option is refused rather than ignored.

Exit codes:
  0  the registry was read and the chosen mode was satisfied
  1  the registry was read and the chosen mode was not satisfied
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-depth', 'maxDepth'],
  ['--max-events', 'maxEvents'],
  ['--max-fields', 'maxFields'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-schema-depth', 'maxSchemaDepth'],
  ['--max-versions', 'maxVersions'],
  ['--timeout-ms', 'timeoutMs'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { registry: null, mode: null, config: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--mode full --mode none` runs a mode nobody asked for. That is the same
   * defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--registry') {
      once('--registry')
      options.registry = takeValue('--registry')
    } else if (argument === '--mode') {
      once('--mode')
      options.mode = takeValue('--mode')
    } else if (argument === '--config') {
      once('--config')
      options.config = takeValue('--config')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const minimum = argument === '--timeout-ms' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new Error(`${argument} requires an integer of ${minimum} or more`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.registry === null) throw new Error('--registry is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let config = { mode: null, owners: null, limits: {} }
  if (options.config !== null) {
    try {
      config = await loadConfigFile(options.config)
    } catch (error) {
      process.stderr.write(`--config is not usable: ${error.message}\n`)
      return 2
    }
  }

  const mode = options.mode ?? config.mode
  if (mode === null || mode === undefined) {
    process.stderr.write('A compatibility mode is required: pass --mode, or declare "mode" in the configuration file.\n')
    return 2
  }
  // Which source decided the mode is a diagnostic, not data: it goes to stderr
  // so that stdout stays a report a consumer can parse, but it is never left
  // unsaid, because a run whose direction came from somewhere the operator
  // forgot about is exactly the run that reports the wrong verdict.
  process.stderr.write(
    `mode ${mode} (from ${options.mode === null ? 'the configuration file' : '--mode'})`
    + `${options.mode !== null && config.mode !== null && config.mode !== options.mode ? `, overriding "${config.mode}" from the configuration file` : ''}\n`,
  )

  let report
  try {
    report = await lintEventRegistry({
      registry: options.registry,
      mode,
      ...(config.owners === null ? {} : { owners: config.owners }),
      limits: { ...config.limits, ...options.limits },
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unexamined} piece(s) of evidence were not obtained across ${report.summary.checked} event file(s) read.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
