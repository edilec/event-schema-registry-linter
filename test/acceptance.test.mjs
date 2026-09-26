import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { MODES, lintEventRegistry } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * The acceptance evidence, asserted on what the tool does rather than on what
 * it says about itself.
 *
 * Two registries differ from each other in exactly one way. In the first,
 * version 2 drops a field version 1 declared required. In the second, version 2
 * changes two descriptions and adds a title, and nothing else. Both are driven
 * through the library and through the real command line in all four modes, and
 * what is asserted is the status and the process exit code.
 *
 * Nothing here consults a table of expected severities. The pair exists so that
 * a change which quietly stopped refusing a removed required field, or started
 * refusing a documentation edit, moves an exit code -- which no edit to a table
 * or a document can do.
 */

const BASE = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['order_id', 'currency'],
  properties: {
    order_id: { type: 'string', description: 'Opaque order identifier.' },
    currency: { type: 'string', description: 'ISO 4217 code.' },
  },
})

/** Version 2 with the required `currency` field taken away. */
const REQUIRED_FIELD_REMOVED = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['order_id'],
  properties: {
    order_id: { type: 'string', description: 'Opaque order identifier.' },
  },
})

/** Version 2 with only documentation keywords touched. */
const DOCUMENTATION_EDIT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['order_id', 'currency'],
  properties: {
    order_id: { type: 'string', description: 'Opaque order identifier, unique for the order lifetime.' },
    currency: { type: 'string', description: 'ISO 4217 alphabetic code.', title: 'Currency' },
  },
})

function declaration(second) {
  return {
    name: 'orders.order_placed',
    owner: 'team-orders',
    producers: ['checkout-api'],
    consumers: ['billing-worker', 'search-indexer'],
    versions: [{ version: 1, schema: BASE }, { version: 2, schema: second }],
  }
}

async function registry(t, second) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-acceptance-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'orders'), { recursive: true })
  await writeFile(join(root, 'orders', 'order-placed.json'), JSON.stringify(declaration(second), null, 2))
  return root
}

async function runCli(root, mode) {
  return execFileAsync(process.execPath, [cli, '--registry', root, '--mode', mode, '--json'], { cwd: projectDirectory })
    .then((result) => ({ code: 0, stdout: result.stdout }), (error) => ({ code: error.code, stdout: error.stdout }))
}

/** backward and full are the modes that refuse a restrictive change. */
const REFUSING_MODES = ['backward', 'full']

for (const mode of MODES) {
  const refuses = REFUSING_MODES.includes(mode)

  test(`a removed required field ${refuses ? 'fails' : 'does not fail'} mode ${mode}`, async (t) => {
    const root = await registry(t, REQUIRED_FIELD_REMOVED)

    const report = await lintEventRegistry({ registry: root, mode })
    assert.equal(report.status, refuses ? 'fail' : 'pass')
    assert.equal(report.summary.errors, refuses ? 1 : 0)

    const removal = report.findings.find((finding) => finding.changeKind === 'required-field-removed')
    assert.ok(removal, 'the removal was not detected at all')
    assert.equal(removal.ruleId, refuses ? 'required-field-removed' : 'change-outside-mode')
    assert.equal(removal.severity, refuses ? 'error' : 'info')
    assert.equal(removal.location.file, 'orders/order-placed.json')
    assert.equal(removal.location.pointer, '/versions/1/schema/properties/currency')
    assert.equal(removal.fromVersion, 1)
    assert.equal(removal.toVersion, 2)

    // The breakage is reported as a candidate, named from the declarations.
    assert.deepEqual(removal.breakage, {
      side: 'consumer',
      refused: refuses,
      candidates: ['billing-worker', 'search-indexer'],
    })
    assert.equal(report.summary.breakageCandidates, refuses ? 1 : 0)

    const result = await runCli(root, mode)
    assert.equal(result.code, refuses ? 1 : 0, `the CLI exited ${result.code}`)
    assert.equal(JSON.parse(result.stdout).status, refuses ? 'fail' : 'pass')
  })

  test(`a documentation edit does not fail mode ${mode}`, async (t) => {
    const root = await registry(t, DOCUMENTATION_EDIT)

    const report = await lintEventRegistry({ registry: root, mode })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.errors, 0)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.breakageCandidates, 0)

    // Every finding is the documentation rule, at info, and it names both edited
    // fields -- so this is not passing because the edit went unnoticed.
    assert.deepEqual([...new Set(report.findings.map((finding) => finding.ruleId))], ['documentation-changed'])
    assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
      '/versions/1/schema/properties/currency',
      '/versions/1/schema/properties/order_id',
    ])
    for (const finding of report.findings) {
      assert.equal(finding.severity, 'info')
      assert.equal(finding.breakage, undefined)
    }

    const result = await runCli(root, mode)
    assert.equal(result.code, 0, `the CLI exited ${result.code}`)
    assert.equal(JSON.parse(result.stdout).status, 'pass')
  })
}

test('the two acceptance registries differ only in the schema edit under test', async (t) => {
  // Without this, both halves above could be passing for a reason that has
  // nothing to do with the change each one is meant to isolate.
  const removed = await lintEventRegistry({ registry: await registry(t, REQUIRED_FIELD_REMOVED), mode: 'full' })
  const documented = await lintEventRegistry({ registry: await registry(t, DOCUMENTATION_EDIT), mode: 'full' })

  assert.equal(removed.summary.checked, 1)
  assert.equal(documented.summary.checked, 1)
  assert.equal(removed.summary.versionPairs, 1)
  assert.equal(documented.summary.versionPairs, 1)
  assert.equal(removed.status, 'fail')
  assert.equal(documented.status, 'pass')
})

test('a documentation edit stays an info even when it rides alongside a real break', async (t) => {
  // The two are reported separately: the edit is never used to explain the
  // break, and the break never drags the edit up to error severity.
  const both = {
    type: 'object',
    additionalProperties: false,
    required: ['order_id'],
    properties: { order_id: { type: 'string', description: 'A different sentence entirely.' } },
  }
  const report = await lintEventRegistry({ registry: await registry(t, both), mode: 'backward' })

  assert.equal(report.status, 'fail')
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.severity]),
    [
      ['required-field-removed', 'error'],
      ['documentation-changed', 'info'],
    ],
  )
})
