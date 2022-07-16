/**
 * event-schema-registry-linter
 *
 * Lints a directory of event declarations: names, owners, version sequences,
 * payload schemas, and the compatibility of each version against the one before
 * it under an explicitly chosen mode. Where a change breaks compatibility the
 * report names the producers or consumers most likely to notice first, as
 * **candidates** -- a registry records declarations, never live traffic.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **The mode is explicit and it changes the verdict.** There is no default.
 *    A run that does not say which direction it is protecting is a
 *    configuration error, because "compatible" is meaningless without it.
 * 2. **A documentation edit fails nothing.** `title`, `description`, `examples`
 *    and `$comment` are a frozen list, and a change confined to them is `info`
 *    in every mode including `full`.
 * 3. **Unknown evidence is never a pass.** Anything unread, undecodable,
 *    unparseable or bounded out makes the run `incomplete` and exits 2.
 * 4. **Output is stable.** No clock reading, no locale, no absolute path and no
 *    filesystem enumeration order reaches stdout, so the same registry always
 *    produces byte-identical output.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { CHANGE_KINDS, MODES, compareSchemas, collectFields, describePath, modeRefuses } from './compare.mjs'
import { validateEventDocument } from './event.mjs'
import { REGISTRY_ROOT, readRegistry } from './registry.mjs'
import { byCodeUnit, decodeUtf8, sanitize } from './text.mjs'

export { CHANGE_KINDS, MODES, modeRefuses } from './compare.mjs'
export { EVENT_KEYS, EVENT_NAME_PATTERN, VERSION_KEYS } from './event.mjs'
export { isInside } from './registry.mjs'
export { CONTROL_CLASSES, byCodeUnit, decodeUtf8, escapePointerSegment, sanitize } from './text.mjs'

export const TOOL_ID = 'event-schema-registry-linter'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A registry is ordinary untrusted input: it can hold a generated 40 MB
 * declaration, a directory tree that nests forever, a schema that recurses past
 * any sensible depth, or ten thousand files. Every limit below is explicit,
 * overridable from the command line, and named in the finding when it is
 * reached. Exceeding one produces an `incomplete` report -- never a quietly
 * shorter answer, and never a pass.
 *
 * `timeoutMs` is the one limit that accepts 0. A budget of zero milliseconds
 * leaves no time to read anything, which is the only way to prove from the
 * outside that the flag is wired through to the walk at all; a documented limit
 * that the command line never reaches is a defect this catalog has already
 * shipped once.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 8,
  maxEvents: 500,
  maxFields: 500,
  maxFileBytes: 262144,
  maxSchemaDepth: 12,
  maxVersions: 50,
  timeoutMs: 10000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that refuses and one that
 * passes. Spread across construction sites as a literal it drifts silently, and
 * flipping one compatibility rule down to a warning turns a refusal into a
 * green build with every test still passing. Every finding takes its severity
 * from here and an unknown rule id throws.
 *
 * This table is the source of truth. It is **not** the guard: three
 * declarations agreeing with each other -- the table, the documented catalog
 * and a map written out again in a test -- are satisfied by one coordinated
 * edit. `test/severity-behaviour.test.mjs` drives every rule below through the
 * real entry point and asserts the status, the printed severity word and the
 * process exit code, none of which an edit to a table can move.
 */
export const RULE_SEVERITY = Object.freeze({
  'additional-properties-relaxed': 'warning',
  'additional-properties-restricted': 'error',
  'change-outside-mode': 'info',
  'consumers-missing': 'warning',
  'directory-too-deep': 'error',
  'documentation-changed': 'info',
  'event-malformed': 'error',
  'event-name-duplicate': 'error',
  'event-name-invalid': 'error',
  'event-not-json': 'error',
  'event-not-utf8': 'error',
  'event-too-large': 'error',
  'event-unknown-key': 'error',
  'event-unreadable': 'error',
  'field-type-narrowed': 'error',
  'field-type-widened': 'error',
  'no-events-found': 'warning',
  'optional-field-added': 'info',
  'optional-field-made-required': 'error',
  'optional-field-removed': 'warning',
  'owner-missing': 'error',
  'owner-unknown': 'error',
  'path-escapes-root': 'error',
  'producers-missing': 'warning',
  'required-field-added': 'error',
  'required-field-made-optional': 'error',
  'required-field-removed': 'error',
  'schema-invalid': 'error',
  'schema-too-deep': 'error',
  'schema-unknown-keyword': 'error',
  'time-budget-exceeded': 'error',
  'too-many-events': 'error',
  'too-many-fields': 'error',
  'too-many-versions': 'error',
  'version-duplicate': 'error',
  'version-sequence-invalid': 'error',
  'versions-missing': 'error',
})

/**
 * Rules that mean evidence was not obtained.
 *
 * Any one of these forces `status: "incomplete"` and exit 2, whatever else the
 * run found. Most of them are `error` severity, so it would be easy to believe
 * the severity alone is doing the work -- it is not: without the flag the run
 * would report `fail` and exit 1, claiming a verdict about inputs it never
 * read. `no-events-found` is a warning, and there the flag is the *only* thing
 * standing between an empty registry and a green build.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'directory-too-deep',
  'event-not-json',
  'event-not-utf8',
  'event-too-large',
  'event-unreadable',
  'no-events-found',
  'path-escapes-root',
  'schema-too-deep',
  'time-budget-exceeded',
  'too-many-events',
  'too-many-fields',
  'too-many-versions',
])

const INCOMPLETE_SET = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze(['clock', 'limits', 'mode', 'owners', 'registry'])
const ALLOWED_CONFIG_KEYS = Object.freeze(['limits', 'mode', 'owners', 'schemaVersion'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The documented sort key, exported so a test can pin each half of it. */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.location.file, right.location.file)
    || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    const minimum = name === 'timeoutMs' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum) {
      throw new TypeError(`Limit "${name}" must be an integer of ${minimum} or more`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

export function validateMode(mode) {
  if (mode === undefined || mode === null) {
    throw new TypeError(`A compatibility mode is required; choose one of ${MODES.join(', ')}`)
  }
  if (typeof mode !== 'string' || !MODES.includes(mode)) {
    throw new TypeError(`Unknown compatibility mode "${sanitize(String(mode), 40)}"; choose one of ${MODES.join(', ')}`)
  }
  return mode
}

export function validateOwners(owners) {
  if (owners === undefined || owners === null) return null
  if (!Array.isArray(owners) || owners.length === 0) {
    throw new TypeError('owners must be a non-empty array of owner names')
  }
  for (const owner of owners) {
    if (typeof owner !== 'string' || owner.trim() === '') throw new TypeError('Every owner must be a non-empty string')
  }
  const unique = [...new Set(owners.map((owner) => sanitize(owner, 80)))]
  if (unique.length !== owners.length) throw new TypeError('owners must not repeat a name')
  return Object.freeze(unique.sort(byCodeUnit))
}

/**
 * Validate a parsed configuration document.
 *
 * An unknown key is refused. Accepting `mode` next to a misspelled `modes`
 * would run a mode nobody chose, and accepting `limits: { maxEvent: 1 }` would
 * leave the real limit at its default while the operator believed otherwise.
 */
export function validateConfig(config) {
  if (!isRecord(config)) throw new TypeError('Configuration must be a JSON object')
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported configuration schemaVersion: ${sanitize(String(config.schemaVersion ?? 'missing'), 40)}`)
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      throw new TypeError(`Unknown configuration key "${sanitize(key, 60)}"; this tool accepts ${ALLOWED_CONFIG_KEYS.join(', ')}`)
    }
  }
  return Object.freeze({
    mode: config.mode === undefined ? null : validateMode(config.mode),
    owners: validateOwners(config.owners),
    limits: validateLimits(config.limits ?? {}),
  })
}

/**
 * Read and validate a configuration file.
 *
 * The configuration is decoded with the same strict decoder as every event
 * document. A tool that hardens its data path and leaves its own configuration
 * path lossy has moved the hole, not closed it.
 */
export async function loadConfigFile(path) {
  let bytes
  try {
    bytes = await readFile(resolve(path))
  } catch (error) {
    throw new TypeError(`Configuration file could not be read: ${error.code ?? error.message}`)
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) throw new TypeError('Configuration file is not valid UTF-8')
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    throw new TypeError(`Configuration file is not valid JSON: ${sanitize(error.message, 120)}`)
  }
  return validateConfig(parsed)
}

function makeFinding(ruleId, message, location, extra = {}) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new TypeError(`Unknown rule id "${ruleId}"`)
  const pointer = location.pointer === undefined || location.pointer === '' ? undefined : location.pointer
  return {
    ruleId,
    severity,
    message,
    location: pointer === undefined ? { file: location.file } : { file: location.file, pointer },
    ...extra,
  }
}

const OTHER_MODE = Object.freeze({ restrictive: 'backward', expansive: 'forward' })

function compatibilityFindings(event, file, mode) {
  const findings = []
  let pairs = 0

  for (let index = 0; index + 1 < event.versions.length; index += 1) {
    const from = event.versions[index]
    const to = event.versions[index + 1]
    pairs += 1
    const changes = compareSchemas(collectFields(from.schema), collectFields(to.schema))

    for (const change of changes) {
      const meta = CHANGE_KINDS[change.kind]
      const refused = modeRefuses(mode, meta.direction)
      const enforceable = meta.direction === 'restrictive' || meta.direction === 'expansive'
      const ruleId = !enforceable || refused ? change.kind : 'change-outside-mode'
      const where = describePath(change.path)
      const versions = `v${from.version} -> v${to.version}`

      let message
      if (!enforceable) {
        message = change.kind === 'documentation-changed'
          ? `${versions}: ${where} changed only in documentation keywords (${change.evidence}), which breaks nothing in any mode.`
          : `${versions}: ${where} ${change.detail}, and an added optional field breaks nothing in any mode.`
      } else if (refused) {
        message = `${versions}: ${where} ${change.detail}. This is a ${meta.direction} change and ${mode} compatibility refuses it.`
      } else {
        message = `${versions}: ${where} ${change.detail}. This is a ${meta.direction} change; ${mode} compatibility does not refuse it, ${OTHER_MODE[meta.direction]} or full would.`
      }

      const extra = {
        event: event.name,
        mode,
        changeKind: change.kind,
        fromVersion: from.version,
        toVersion: to.version,
        evidence: sanitize(change.evidence, 80),
      }
      if (meta.side !== null) {
        const candidates = meta.side === 'consumer' ? event.consumers : event.producers
        extra.breakage = { side: meta.side, refused, candidates }
      }

      findings.push(makeFinding(ruleId, message, { file, pointer: `/versions/${to.index}/schema${change.path}` }, extra))
    }
  }

  return { findings, pairs }
}

/**
 * Lint a registry directory.
 *
 * Throws a `TypeError` for anything that makes the run impossible to define --
 * a missing mode, an unknown limit, a root that is not a readable directory.
 * Those are configuration errors: the run never had a subject, so there is
 * nothing to report about. Everything that is a fact about the registry comes
 * back inside the report.
 */
export async function lintEventRegistry(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${sanitize(key, 60)}"`)
  }
  if (typeof options.registry !== 'string' || options.registry.trim() === '') {
    throw new TypeError('A registry directory is required')
  }

  const mode = validateMode(options.mode)
  const limits = validateLimits(options.limits ?? {})
  const owners = validateOwners(options.owners)
  const clock = options.clock ?? (() => performance.now())
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')

  let realRoot
  try {
    realRoot = await realpath(resolve(options.registry))
  } catch (error) {
    throw new TypeError(`Registry directory could not be resolved: ${error.code ?? error.message}`)
  }
  let info
  try {
    info = await stat(realRoot)
  } catch (error) {
    throw new TypeError(`Registry directory could not be inspected: ${error.code ?? error.message}`)
  }
  if (!info.isDirectory()) throw new TypeError('Registry must be a directory of event declaration files')

  const { documents, problems, candidates } = await readRegistry({ realRoot, limits, clock })
  const findings = problems.map((problem) => makeFinding(problem.ruleId, problem.message, { file: problem.file }))

  const seenNames = new Map()
  let events = 0
  let versionPairs = 0

  for (const { file, document } of documents) {
    const { event, problems: documentProblems } = validateEventDocument(document, limits)
    for (const problem of documentProblems) {
      findings.push(makeFinding(
        problem.ruleId,
        problem.message,
        { file, pointer: problem.pointer },
        problem.evidence === undefined ? {} : { evidence: sanitize(problem.evidence, 80) },
      ))
    }
    if (event === null) continue
    events += 1

    if (seenNames.has(event.name)) {
      findings.push(makeFinding(
        'event-name-duplicate',
        `Event name "${sanitize(event.name, 80)}" is already declared in ${seenNames.get(event.name)}. Two declarations of one name make the registry's answer depend on which file a reader opened.`,
        { file, pointer: '/name' },
        { event: event.name, evidence: sanitize(event.name, 80) },
      ))
    } else {
      seenNames.set(event.name, file)
    }

    if (owners !== null && event.owner !== null && !owners.includes(event.owner)) {
      findings.push(makeFinding(
        'owner-unknown',
        `Owner "${sanitize(event.owner, 80)}" is not one of the owners this run accepts.`,
        { file, pointer: '/owner' },
        { event: event.name, evidence: sanitize(event.owner, 80) },
      ))
    }

    const eventMode = event.compatibility ?? mode
    const result = compatibilityFindings(event, file, eventMode)
    findings.push(...result.findings)
    versionPairs += result.pairs
  }

  // A registry holding no declarations at all is not a registry that passed:
  // "pass" with nothing checked is green on no evidence. Where files were found
  // but could not be read, the read failures say so themselves and each one is
  // already an incomplete rule, so this finding stays about an empty tree.
  if (candidates === 0) {
    findings.push(makeFinding(
      'no-events-found',
      'No event declaration files were found under the registry root, so this run has no evidence to report.',
      { file: REGISTRY_ROOT },
    ))
  }

  findings.sort(compareFindingRows)

  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const unexamined = findings.filter((finding) => INCOMPLETE_SET.has(finding.ruleId)).length
  const breakageCandidates = findings.filter((finding) => finding.breakage?.refused === true).length

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: unexamined > 0 ? 'incomplete' : (errors > 0 ? 'fail' : 'pass'),
    summary: {
      checked: documents.length,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      events,
      versionPairs,
      breakageCandidates,
      unexamined,
      mode,
    },
    findings,
  }
}

export function formatReport(report) {
  const lines = report.findings.map((finding) =>
    `${finding.severity.toUpperCase().padEnd(7)} ${finding.location.file}${finding.location.pointer ?? ''} ${finding.ruleId} ${finding.message}`)
  lines.push('')
  lines.push(
    `${report.summary.checked} event file(s) checked in mode ${report.summary.mode}: `
    + `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info, `
    + `status ${report.status}.`,
  )
  lines.push(
    `${report.summary.breakageCandidates} producer/consumer breakage candidate(s) across ${report.summary.versionPairs} version pair(s); `
    + 'candidates come from declared producers and consumers, not from observed traffic.',
  )
  if (report.summary.unexamined > 0) {
    lines.push(`${report.summary.unexamined} piece(s) of evidence were not obtained, so this run is incomplete rather than a verdict.`)
  }
  return `${lines.join('\n')}\n`
}
