import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { formatReport, lintEventRegistry } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * What each rule does to a run, written out one rule at a time.
 *
 * This file is the severity guard, and the only thing that makes it one is that
 * it shares nothing with the severity table. It imports no table, builds no map
 * of rule to expected severity, and takes no expectation from a parameter: every
 * outcome below is a literal spelled out at the assertion. A coordinated edit
 * that flips a rule in `src/index.mjs`, in `docs/rule-catalog.md` and in every
 * expectation map in this suite has nothing here to agree with, so it lands on
 * an assertion that says `'fail'`, or `1`, or `'ERROR'`, and fails.
 *
 * That is the defect this file exists because of. Its predecessor drove the real
 * entry point too, but compared what came back against a `severity` field in the
 * row that built the fixture -- a fourth declaration, edited by the same hand as
 * the other three, and green for 30 of 37 rules after a flip.
 *
 * For a rule that decides the verdict, a downgrade moves three things at once:
 * the status, the error count and the exit code. For a rule that also marks the
 * run incomplete the exit code is 2 whichever severity it carries, because
 * missing evidence is never a pass; there the count and the printed word are
 * what move, and they are asserted instead.
 *
 * Fixtures are isolated: each registry produces the one rule under test and
 * nothing else, asserted by listing the rule ids the run emitted. Nothing else
 * can be deciding the status or the exit code.
 */

const json = (value) => JSON.stringify(value, null, 2)

const S = { type: 'string' }

const obj = (properties, required, extra = {}) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
  ...extra,
})

const event = (overrides = {}) => ({
  name: 'orders.order_placed',
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions: [{ version: 1, schema: obj({ a: S }, ['a']) }],
  ...overrides,
})

/** Two versions of one event that differ only in the way under test. */
const evolving = (first, second) => event({ versions: [{ version: 1, schema: first }, { version: 2, schema: second }] })

/** A second, entirely clean declaration, so a fixture can hold a valid file. */
const CLEAN = json(event({ name: 'billing.invoice_issued' }))

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-outcome-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of Object.keys(files).sort()) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, files[path])
  }
  return root
}

/** A registry holding exactly one event declaration. */
const only = (t, declaration) => tree(t, { 'orders.json': json(declaration) })

async function configFile(t, owners) {
  const directory = await mkdtemp(join(tmpdir(), 'event-registry-outcome-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  await writeFile(path, json({ schemaVersion: '1', owners }))
  return path
}

/** The exit code of the real process, which is the outcome that ships. */
const exitCode = (root, mode, extra = []) =>
  execFileAsync(process.execPath, [cli, '--registry', root, '--mode', mode, ...extra], { cwd: projectDirectory })
    .then(() => 0, (error) => error.code)

/** The human report line the rule reached, so the printed word can be read off it. */
const reportLine = (report, ruleId) =>
  formatReport(report).split(String.fromCharCode(10)).find((line) => line.includes(` ${ruleId} `))

test('additional-properties-relaxed is a warning and the run still passes', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S }, ['a']),
    obj({ a: S }, ['a'], { additionalProperties: true }),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'forward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['additional-properties-relaxed'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'additional-properties-relaxed').startsWith('WARNING'), true)
  assert.equal(await exitCode(root, 'forward'), 0)
})

test('additional-properties-restricted is an error and the run fails', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S }, ['a'], { additionalProperties: true }),
    obj({ a: S }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['additional-properties-restricted'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'additional-properties-restricted').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('change-outside-mode is information and the run passes', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S, b: S }, ['a', 'b']),
    obj({ a: S }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'forward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['change-outside-mode'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(reportLine(report, 'change-outside-mode').startsWith('INFO'), true)
  assert.equal(await exitCode(root, 'forward'), 0)
})

test('consumers-missing is a warning and the run still passes', async (t) => {
  const root = await only(t, { ...event(), consumers: undefined })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['consumers-missing'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'consumers-missing').startsWith('WARNING'), true)
  assert.equal(await exitCode(root, 'backward'), 0)
})

test('directory-too-deep is an error and the run is incomplete', async (t) => {
  const root = await tree(t, { 'ok.json': CLEAN, 'deep/deeper/buried.json': CLEAN })
  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { maxDepth: 1 } })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['directory-too-deep'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'directory-too-deep').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--max-depth', '1']), 2)
})

test('documentation-changed is information and passes even under full', async (t) => {
  const root = await only(t, evolving(
    obj({ a: { type: 'string', description: 'before' } }, ['a']),
    obj({ a: { type: 'string', description: 'after' } }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'full' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['documentation-changed'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(reportLine(report, 'documentation-changed').startsWith('INFO'), true)
  assert.equal(await exitCode(root, 'full'), 0)
})

test('event-malformed is an error and the run fails', async (t) => {
  const root = await only(t, event({ compatibility: 'sideways' }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-malformed'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-malformed').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('event-name-duplicate is an error and the run fails', async (t) => {
  const root = await tree(t, { 'a.json': json(event()), 'b.json': json(event()) })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-name-duplicate'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-name-duplicate').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('event-name-invalid is an error and the run fails', async (t) => {
  const root = await only(t, event({ name: 'OrderPlaced' }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-name-invalid'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-name-invalid').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('event-not-json is an error and the run is incomplete', async (t) => {
  const root = await tree(t, { 'orders.json': '{ "name": ' })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-not-json'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-not-json').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 2)
})

test('event-not-utf8 is an error and the run is incomplete', async (t) => {
  const root = await tree(t, { 'orders.json': Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-not-utf8'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-not-utf8').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 2)
})

test('event-too-large is an error and the run is incomplete', async (t) => {
  const root = await only(t, event())
  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { maxFileBytes: 32 } })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-too-large'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-too-large').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--max-file-bytes', '32']), 2)
})

test('event-unknown-key is an error and the run fails', async (t) => {
  const root = await only(t, { ...event(), consumer: ['billing-worker'] })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-unknown-key'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-unknown-key').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('event-unreadable is an error and the run is incomplete', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-outcome-locked-'))
  const locked = join(root, 'locked')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'buried.json'), CLEAN)
  await writeFile(join(root, 'ok.json'), CLEAN)
  t.after(async () => {
    await chmod(locked, 0o755).catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  await chmod(locked, 0o000)
  // A process that can read the directory anyway -- root, or a filesystem with
  // no POSIX modes -- would make the assertions below meaningless.
  const enforced = await readdir(locked).then(() => false, () => true)
  if (!enforced) {
    t.skip('the filesystem did not enforce the mode change')
    return
  }
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-unreadable'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'event-unreadable').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 2)
})

test('field-type-narrowed is an error and the run fails', async (t) => {
  const root = await only(t, evolving(
    obj({ a: { type: 'number' } }, ['a']),
    obj({ a: { type: 'integer' } }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['field-type-narrowed'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'field-type-narrowed').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('field-type-widened is an error and the run fails', async (t) => {
  const root = await only(t, evolving(
    obj({ a: { type: 'integer' } }, ['a']),
    obj({ a: { type: 'number' } }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'forward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['field-type-widened'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'field-type-widened').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'forward'), 1)
})

test('no-events-found is a warning and the run is still incomplete', async (t) => {
  // The one rule where the incomplete flag is the only thing standing between
  // an empty registry and a green build: a warning does not fail a run.
  const root = await tree(t, { 'notes/README.txt': 'not a declaration' })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['no-events-found'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'no-events-found').startsWith('WARNING'), true)
  assert.equal(await exitCode(root, 'backward'), 2)
})

test('optional-field-added is information and passes even under full', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S }, ['a']),
    obj({ a: S, b: S }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'full' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['optional-field-added'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(reportLine(report, 'optional-field-added').startsWith('INFO'), true)
  assert.equal(await exitCode(root, 'full'), 0)
})

test('optional-field-made-required is an error and the run fails', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S, b: S }, ['a']),
    obj({ a: S, b: S }, ['a', 'b']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'forward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['optional-field-made-required'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'optional-field-made-required').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'forward'), 1)
})

test('optional-field-removed is a warning and the run still passes', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S, b: S }, ['a']),
    obj({ a: S }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['optional-field-removed'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'optional-field-removed').startsWith('WARNING'), true)
  assert.equal(await exitCode(root, 'backward'), 0)
})

test('owner-missing is an error and the run fails', async (t) => {
  const root = await only(t, { ...event(), owner: undefined })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['owner-missing'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'owner-missing').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('owner-unknown is an error and the run fails', async (t) => {
  const root = await only(t, event())
  const config = await configFile(t, ['team-somebody-else'])
  const report = await lintEventRegistry({ registry: root, mode: 'backward', owners: ['team-somebody-else'] })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['owner-unknown'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'owner-unknown').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--config', config]), 1)
})

test('path-escapes-root is an error and the run is incomplete', async (t) => {
  const outside = await tree(t, { 'secret.json': json(event({ name: 'secret.not_yours' })) })
  const root = await tree(t, { 'ok.json': CLEAN })
  await symlink(join(outside, 'secret.json'), join(root, 'leak.json'))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['path-escapes-root'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'path-escapes-root').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 2)
})

test('producers-missing is a warning and the run still passes', async (t) => {
  const root = await only(t, { ...event(), producers: undefined })
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['producers-missing'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'producers-missing').startsWith('WARNING'), true)
  assert.equal(await exitCode(root, 'backward'), 0)
})

test('required-field-added is an error and the run fails', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S }, ['a']),
    obj({ a: S, b: S }, ['a', 'b']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'forward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['required-field-added'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'required-field-added').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'forward'), 1)
})

test('required-field-made-optional is an error and the run fails', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S, b: S }, ['a', 'b']),
    obj({ a: S, b: S }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['required-field-made-optional'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'required-field-made-optional').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('required-field-removed is an error and the run fails', async (t) => {
  const root = await only(t, evolving(
    obj({ a: S, b: S }, ['a', 'b']),
    obj({ a: S }, ['a']),
  ))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['required-field-removed'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'required-field-removed').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('schema-invalid is an error and the run fails', async (t) => {
  const root = await only(t, event({ versions: [{ version: 1, schema: { type: 'strung' } }] }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['schema-invalid'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'schema-invalid').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('schema-too-deep is an error and the run is incomplete', async (t) => {
  const root = await only(t, event())
  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { maxSchemaDepth: 1 } })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['schema-too-deep'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'schema-too-deep').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--max-schema-depth', '1']), 2)
})

test('schema-unknown-keyword is an error and the run fails', async (t) => {
  const root = await only(t, event({
    versions: [{ version: 1, schema: { ...obj({ a: S }, ['a']), requried: ['a'] } }],
  }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['schema-unknown-keyword'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'schema-unknown-keyword').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('time-budget-exceeded is an error and the run is incomplete', async (t) => {
  const root = await only(t, event())
  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { timeoutMs: 0 } })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['time-budget-exceeded'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'time-budget-exceeded').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--timeout-ms', '0']), 2)
})

test('too-many-events is an error and the run is incomplete', async (t) => {
  const root = await tree(t, { 'a.json': json(event()), 'b.json': CLEAN })
  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { maxEvents: 1 } })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['too-many-events'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'too-many-events').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--max-events', '1']), 2)
})

test('too-many-fields is an error and the run is incomplete', async (t) => {
  const root = await only(t, event({ versions: [{ version: 1, schema: obj({ a: S, b: S }, ['a']) }] }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { maxFields: 1 } })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['too-many-fields'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'too-many-fields').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--max-fields', '1']), 2)
})

test('too-many-versions is an error and the run is incomplete', async (t) => {
  const root = await only(t, evolving(obj({ a: S }, ['a']), obj({ a: S }, ['a'])))
  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { maxVersions: 1 } })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['too-many-versions'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'too-many-versions').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward', ['--max-versions', '1']), 2)
})

test('version-duplicate is an error and the run fails', async (t) => {
  const root = await only(t, event({
    versions: [
      { version: 1, schema: obj({ a: S }, ['a']) },
      { version: 1, schema: obj({ a: S }, ['a']) },
    ],
  }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['version-duplicate'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'version-duplicate').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('version-sequence-invalid is an error and the run fails', async (t) => {
  const root = await only(t, event({
    versions: [
      { version: 1, schema: obj({ a: S }, ['a']) },
      { version: 3, schema: obj({ a: S }, ['a']) },
    ],
  }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['version-sequence-invalid'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'version-sequence-invalid').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})

test('versions-missing is an error and the run fails', async (t) => {
  const root = await only(t, event({ versions: [] }))
  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['versions-missing'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(reportLine(report, 'versions-missing').startsWith('ERROR'), true)
  assert.equal(await exitCode(root, 'backward'), 1)
})
