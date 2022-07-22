import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CHANGE_KINDS, MODES, lintEventRegistry } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * The mode is what decides the verdict, so the matrix is driven, not declared.
 *
 * Each row below is a registry whose two versions differ in exactly one way.
 * The same registry is run in all four modes and what is asserted is the status
 * and the exit code of the process. `backward` refuses the restrictive half of
 * the matrix, `forward` the expansive half, `full` both, `none` neither -- and
 * a row whose direction was quietly reclassified moves two exit codes at once.
 */

const json = (value) => JSON.stringify(value, null, 2)

const obj = (properties, required, extra = {}) => ({
  type: 'object', additionalProperties: false, required, properties, ...extra,
})

const S = { type: 'string' }

const ROWS = [
  {
    kind: 'required-field-removed',
    from: obj({ a: S, b: S }, ['a', 'b']),
    to: obj({ a: S }, ['a']),
  },
  {
    kind: 'required-field-made-optional',
    from: obj({ a: S, b: S }, ['a', 'b']),
    to: obj({ a: S, b: S }, ['a']),
  },
  {
    kind: 'field-type-narrowed',
    from: obj({ a: { type: ['string', 'null'] } }, ['a']),
    to: obj({ a: S }, ['a']),
  },
  {
    kind: 'optional-field-removed',
    refusedSeverity: 'warning',
    from: obj({ a: S, b: S }, ['a']),
    to: obj({ a: S }, ['a']),
  },
  {
    kind: 'additional-properties-relaxed',
    refusedSeverity: 'warning',
    from: obj({ a: S }, ['a']),
    to: obj({ a: S }, ['a'], { additionalProperties: true }),
  },
  {
    kind: 'additional-properties-restricted',
    from: obj({ a: S }, ['a'], { additionalProperties: true }),
    to: obj({ a: S }, ['a']),
  },
  {
    kind: 'required-field-added',
    from: obj({ a: S }, ['a']),
    to: obj({ a: S, b: S }, ['a', 'b']),
  },
  {
    kind: 'optional-field-made-required',
    from: obj({ a: S, b: S }, ['a']),
    to: obj({ a: S, b: S }, ['a', 'b']),
  },
  {
    kind: 'field-type-widened',
    from: obj({ a: S }, ['a']),
    to: obj({ a: { type: ['string', 'null'] } }, ['a']),
  },
  {
    kind: 'optional-field-added',
    from: obj({ a: S }, ['a']),
    to: obj({ a: S, b: S }, ['a']),
  },
  {
    kind: 'documentation-changed',
    from: obj({ a: { type: 'string', description: 'before' } }, ['a']),
    to: obj({ a: { type: 'string', description: 'after' } }, ['a']),
  },
]

/** Which modes refuse a change moving in each direction. */
const REFUSING = Object.freeze({
  restrictive: ['backward', 'full'],
  expansive: ['forward', 'full'],
  neutral: [],
  documentation: [],
})

async function registry(t, row, compatibility) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-modes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'orders.json'), json({
    name: 'orders.order_placed',
    owner: 'team-orders',
    ...(compatibility === undefined ? {} : { compatibility }),
    producers: ['checkout-api'],
    consumers: ['billing-worker'],
    versions: [{ version: 1, schema: row.from }, { version: 2, schema: row.to }],
  }))
  return root
}

async function runCli(root, mode) {
  return execFileAsync(process.execPath, [cli, '--registry', root, '--mode', mode], { cwd: projectDirectory })
    .then(() => 0, (error) => error.code)
}

for (const row of ROWS) {
  const direction = CHANGE_KINDS[row.kind].direction
  const enforceable = direction === 'restrictive' || direction === 'expansive'
  for (const mode of MODES) {
    const refused = REFUSING[direction].includes(mode)
    // A refused change carries its own rule id and its own severity; a change
    // the mode does not refuse is recorded as information under
    // `change-outside-mode`, so the run still reports it and still passes.
    const severity = refused ? (row.refusedSeverity ?? 'error') : 'info'
    const fails = severity === 'error'

    test(`${row.kind} is ${refused ? 'refused' : 'not refused'} by mode ${mode}`, async (t) => {
      const root = await registry(t, row)
      const report = await lintEventRegistry({ registry: root, mode })

      assert.equal(report.findings.length, 1, `the fixture for ${row.kind} produced more than the change under test`)
      const [finding] = report.findings
      assert.equal(finding.changeKind, row.kind, 'the fixture did not produce the change it claims to')
      assert.equal(finding.severity, severity)
      assert.equal(finding.ruleId, refused || !enforceable ? row.kind : 'change-outside-mode')
      assert.equal(report.status, fails ? 'fail' : 'pass')

      assert.equal(await runCli(root, mode), fails ? 1 : 0)
    })
  }
}

test('a change outside the active mode names the mode that would refuse it', async (t) => {
  const restrictive = await lintEventRegistry({ registry: await registry(t, ROWS[0]), mode: 'forward' })
  assert.match(restrictive.findings[0].message, /forward compatibility does not refuse it, backward or full would/)

  const expansive = await lintEventRegistry({ registry: await registry(t, ROWS[4]), mode: 'backward' })
  assert.match(expansive.findings[0].message, /backward compatibility does not refuse it, forward or full would/)
})

test('an event declaring its own compatibility overrides the run mode for that event', async (t) => {
  // A registry moving one event to a stricter contract should not have to move
  // the whole run, and the finding records which mode judged it.
  const root = await registry(t, ROWS[0], 'full')
  const report = await lintEventRegistry({ registry: root, mode: 'none' })

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.mode, 'none', 'the run mode is what the summary reports')
  assert.equal(report.findings[0].mode, 'full', 'the finding records the mode that judged it')
  assert.equal(report.findings[0].ruleId, 'required-field-removed')
  assert.equal(await runCli(root, 'none'), 1)
})

test('an event declaring a looser compatibility than the run is also honoured', async (t) => {
  const root = await registry(t, ROWS[0], 'none')
  const report = await lintEventRegistry({ registry: root, mode: 'full' })

  assert.equal(report.status, 'pass')
  assert.equal(report.findings[0].ruleId, 'change-outside-mode')
  assert.equal(await runCli(root, 'full'), 0)
})

test('every change kind is exercised by the matrix', () => {
  assert.deepEqual(ROWS.map((row) => row.kind).sort(), Object.keys(CHANGE_KINDS).sort())
})

test('compatibility is checked between consecutive versions, pair by pair', async (t) => {
  // Three versions make two pairs. A tool that only compared the first and the
  // last would miss a break that was introduced and then papered over, and one
  // that only compared against the latest would report the same break twice.
  const root = await mkdtemp(join(tmpdir(), 'event-registry-modes-chain-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'orders.json'), json({
    name: 'orders.order_placed',
    owner: 'team-orders',
    producers: ['checkout-api'],
    consumers: ['billing-worker'],
    versions: [
      { version: 1, schema: obj({ a: S, b: S }, ['a', 'b']) },
      { version: 2, schema: obj({ a: S }, ['a']) },
      { version: 3, schema: obj({ a: S, b: S }, ['a', 'b']) },
    ],
  }))

  const report = await lintEventRegistry({ registry: root, mode: 'full' })
  assert.equal(report.summary.versionPairs, 2)
  assert.deepEqual(
    report.findings.map((finding) => [finding.fromVersion, finding.toVersion, finding.ruleId]),
    [
      [1, 2, 'required-field-removed'],
      [2, 3, 'required-field-added'],
    ],
  )
})
