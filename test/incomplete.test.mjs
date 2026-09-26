import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { INCOMPLETE_RULES, lintEventRegistry } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * Unknown evidence is never a pass, and never a plain verdict either.
 *
 * Deleting one `incomplete` flag has already let an entirely unread input
 * report `pass` in this catalog, with the full test suite still green. Each
 * case here is built so that removing the flag moves an observable outcome:
 *
 * - Where the accompanying rule is a warning, the flag is the **only** thing
 *   between the run and `pass`/0. `no-events-found` is that case.
 * - Where the rule is an error, the flag is what separates `incomplete`/2 --
 *   "I could not look" -- from `fail`/1, which claims a verdict about inputs
 *   that were never read.
 */

const json = (value) => JSON.stringify(value, null, 2)

const CLEAN = json({
  name: 'orders.order_placed',
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions: [{ version: 1, schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } }],
})

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-incomplete-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

async function runCli(root, extra = []) {
  return execFileAsync(process.execPath, [cli, '--registry', root, '--mode', 'backward', '--json', ...extra], { cwd: projectDirectory })
    .then((result) => ({ code: 0, stdout: result.stdout }), (error) => ({ code: error.code, stdout: error.stdout }))
}

test('an empty registry is incomplete, not a pass on no evidence', async (t) => {
  // The strongest case: `no-events-found` is a warning, so without the
  // incomplete flag this run would be pass/0 -- green on nothing at all.
  const root = await tree(t, { 'notes.txt': 'not a declaration' })

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.unexamined, 1)

  const result = await runCli(root)
  assert.equal(result.code, 2, 'a registry with nothing in it exited as though it had passed')
})

test('an otherwise clean registry with one unread file is incomplete, not a fail', async (t) => {
  // Every other declaration passes. Without the flag this would be fail/1,
  // which claims the tool reached a verdict about a file it could not decode.
  const root = await tree(t, { 'good.json': CLEAN, 'bad.json': Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) })

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.unexamined, 1)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-not-utf8'])

  const result = await runCli(root)
  assert.equal(result.code, 2)
  assert.equal(JSON.parse(result.stdout).status, 'incomplete')
})

test('incomplete outranks fail when a run has both', async (t) => {
  // A registry with a real compatibility break and a file that could not be
  // read must exit 2, not 1: the break is real, but the run is still not a
  // complete answer, and a consumer needs to know which.
  const breaking = json({
    name: 'billing.invoice_issued',
    owner: 'team-orders',
    producers: ['checkout-api'],
    consumers: ['billing-worker'],
    versions: [
      { version: 1, schema: { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } } },
      { version: 2, schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } },
    ],
  })
  const root = await tree(t, { 'breaking.json': breaking, 'bad.json': '{ "name": ' })

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId).sort(), ['event-not-json', 'required-field-removed'])

  const result = await runCli(root)
  assert.equal(result.code, 2, 'a run that also failed reported the failure and hid the missing evidence')
})

test('a bounded-out limit is incomplete rather than a quietly shorter answer', async (t) => {
  // The other half of "never silently truncate": the finding names the limit,
  // and the report says how much was not examined.
  const root = await tree(t, { 'a.json': CLEAN, 'b.json': CLEAN.replace('orders.order_placed', 'billing.invoice_issued') })

  const report = await lintEventRegistry({ registry: root, mode: 'backward', limits: { maxEvents: 1 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.unexamined, 1)
  assert.match(report.findings[0].message, /maxEvents limit of 1/)

  const result = await runCli(root, ['--max-events', '1'])
  assert.equal(result.code, 2)
})

test('every rule that marks a run incomplete is exercised by a real run somewhere', async () => {
  // The list is a declaration; test/severity-outcomes.test.mjs drives each of
  // these through the CLI and asserts exit 2. This asserts the two stay in
  // step, so a rule cannot be added to the list without a run that proves it.
  // What those runs expect is written out inside them and is deliberately not
  // read from here: this looks only for the run, never for its severity.
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile(join(projectDirectory, 'test', 'severity-outcomes.test.mjs'), 'utf8'))
  const blocks = source.split(`${String.fromCharCode(10)}test(`)
  for (const ruleId of INCOMPLETE_RULES) {
    const block = blocks.find((candidate) => candidate.startsWith(`'${ruleId} `))
    assert.ok(block !== undefined, `${ruleId} has no run of its own`)
    assert.ok(
      block.includes("assert.equal(report.status, 'incomplete')"),
      `${ruleId} is not driven to an incomplete report`,
    )
    assert.match(block, /await exitCode\(.*\), 2\)/, `${ruleId} is not driven to exit 2`)
  }
})
