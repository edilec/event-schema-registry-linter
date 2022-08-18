import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { REPORT_SCHEMA_VERSION, RULE_SEVERITY, TOOL_ID, formatReport, lintEventRegistry } from '../src/index.mjs'

/** The report envelope, the finding shape and the human rendering. */

const json = (value) => JSON.stringify(value, null, 2)

const schema = (properties, required) => ({ type: 'object', additionalProperties: false, required, properties })

const BREAKING = json({
  name: 'orders.order_placed',
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['search-indexer', 'billing-worker'],
  versions: [
    { version: 1, schema: schema({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']) },
    { version: 2, schema: schema({ a: { type: 'string' } }, ['a']) },
  ],
})

const CLEAN = json({
  name: 'billing.invoice_issued',
  owner: 'team-billing',
  producers: ['billing-worker'],
  consumers: ['accounting-export'],
  versions: [{ version: 1, schema: schema({ a: { type: 'string' } }, ['a']) }],
})

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-linter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

test('the report carries the documented envelope', async (t) => {
  const root = await tree(t, { 'a.json': CLEAN })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
  assert.equal(report.tool, TOOL_ID)
  assert.equal(report.tool, 'event-schema-registry-linter')
  assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
  assert.deepEqual(Object.keys(report.summary), [
    'checked', 'errors', 'warnings', 'info', 'events', 'versionPairs', 'breakageCandidates', 'unexamined', 'mode',
  ])
  for (const key of ['checked', 'errors', 'warnings', 'info', 'events', 'versionPairs', 'breakageCandidates', 'unexamined']) {
    assert.equal(Number.isInteger(report.summary[key]), true, `summary.${key} is not an integer`)
  }
  assert.equal(Array.isArray(report.findings), true)
})

test('the summary counts agree with the findings that produced them', async (t) => {
  const root = await tree(t, { 'a.json': BREAKING, 'b.json': CLEAN })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  const bySeverity = (severity) => report.findings.filter((finding) => finding.severity === severity).length
  assert.equal(report.summary.errors, bySeverity('error'))
  assert.equal(report.summary.warnings, bySeverity('warning'))
  assert.equal(report.summary.info, bySeverity('info'))
  assert.equal(report.summary.errors + report.summary.warnings + report.summary.info, report.findings.length)
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.events, 2)
  assert.equal(report.summary.versionPairs, 1)
  assert.equal(report.summary.unexamined, 0)
})

test('a breakage candidate names the declared side and counts once', async (t) => {
  const root = await tree(t, { 'a.json': BREAKING })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  const [finding] = report.findings
  assert.equal(finding.ruleId, 'required-field-removed')
  assert.equal(finding.event, 'orders.order_placed')
  assert.equal(finding.mode, 'backward')
  assert.deepEqual(finding.breakage, {
    side: 'consumer',
    refused: true,
    candidates: ['billing-worker', 'search-indexer'],
  })
  assert.equal(report.summary.breakageCandidates, 1)
})

test('a finding location is relative and its pointer is optional', async (t) => {
  const root = await tree(t, { 'nested/a.json': BREAKING })
  const withPointer = await lintEventRegistry({ registry: root, mode: 'backward' })
  assert.equal(withPointer.findings[0].location.file, 'nested/a.json')
  assert.equal(withPointer.findings[0].location.pointer, '/versions/1/schema/properties/b')

  const empty = await lintEventRegistry({ registry: await tree(t, {}), mode: 'backward' })
  assert.deepEqual(empty.findings[0].location, { file: '.' })
  assert.equal(Object.hasOwn(empty.findings[0].location, 'pointer'), false)
})

test('the severity table is frozen and holds only severities the report can count', () => {
  // Severity comes from this table and nowhere else: every finding is built by
  // one function, which reads the table and throws on a rule id that is not in
  // it. Re-reading that lookup back out of the finding, or re-checking that the
  // rule id is in the table, asserts what the construction already guaranteed
  // and cannot fail -- what the two loops that used to stand here did.
  //
  // What is worth asserting is the table itself. Frozen, so nothing adds an
  // entry at run time; and carrying only the three severities the summary knows
  // how to count, because `info` is counted as the remainder, so a fourth value
  // would be silently totalled as information and never named.
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} carries the severity ${severity}`)
  }
})

test('formatReport renders one line per finding plus a summary', async (t) => {
  const root = await tree(t, { 'a.json': BREAKING, 'b.json': CLEAN })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  const lines = formatReport(report).split(String.fromCharCode(10))

  assert.equal(lines[0], 'ERROR   a.json/versions/1/schema/properties/b required-field-removed '
    + 'v1 -> v2: b was removed; the earlier version declared it string. '
    + 'This is a restrictive change and backward compatibility refuses it.')
  assert.equal(lines[report.findings.length], '')
  assert.equal(
    lines[report.findings.length + 1],
    '2 event file(s) checked in mode backward: 1 error, 0 warning, 0 info, status fail.',
  )
  assert.match(lines[report.findings.length + 2], /^1 producer\/consumer breakage candidate\(s\) across 1 version pair\(s\)/)
  assert.match(lines[report.findings.length + 2], /not from observed traffic\.$/)
})

test('formatReport says so when evidence was not obtained', async (t) => {
  const root = await tree(t, { 'a.json': BREAKING, 'bad.json': '{' })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  assert.match(formatReport(report), /1 piece\(s\) of evidence were not obtained, so this run is incomplete rather than a verdict\./)
})

test('evidence is present, bounded and never the whole document', async (t) => {
  // Long enough to be truncated, short enough that the length rule is not what
  // catches it: the point is the evidence field, not the branch.
  const long = 'Z'.repeat(93)
  const root = await tree(t, {
    'a.json': json({
      name: `orders.${long}`,
      owner: 'team-orders',
      producers: ['checkout-api'],
      consumers: ['billing-worker'],
      versions: [{ version: 1, schema: schema({ a: { type: 'string' } }, ['a']) }],
    }),
  })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  const [finding] = report.findings
  assert.equal(finding.ruleId, 'event-name-invalid')
  assert.equal(finding.evidence.length <= 83, true, `evidence was ${finding.evidence.length} characters`)
  assert.equal(finding.evidence.endsWith('...'), true)
})

test('the library refuses an options object it cannot act on', async () => {
  await assert.rejects(() => lintEventRegistry('not an object'), /Options must be an object/)
  await assert.rejects(() => lintEventRegistry({ mode: 'backward' }), /A registry directory is required/)
  await assert.rejects(() => lintEventRegistry({ registry: '.', mode: 'sideways' }), /Unknown compatibility mode/)
  await assert.rejects(() => lintEventRegistry({ registry: '.' }), /A compatibility mode is required/)
  await assert.rejects(() => lintEventRegistry({ registry: '.', mode: 'backward', clock: 5 }), /clock must be a function/)
  await assert.rejects(() => lintEventRegistry({ registry: '.', mode: 'backward', limits: { nope: 1 } }), /Unknown limit "nope"/)
})

test('two runs over the same registry return deeply equal reports', async (t) => {
  const root = await tree(t, { 'a.json': BREAKING, 'b.json': CLEAN })
  const first = await lintEventRegistry({ registry: root, mode: 'backward' })
  const second = await lintEventRegistry({ registry: root, mode: 'backward' })
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})
