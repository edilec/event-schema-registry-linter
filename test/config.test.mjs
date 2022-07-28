import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_LIMITS, loadConfigFile, validateConfig, validateLimits, validateMode, validateOwners } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * The configuration path, held to the same standard as the data path.
 *
 * One tool in this catalog hardened every byte of its input and then read its
 * own configuration file with a lenient decoder, so a configuration that was
 * not UTF-8 silently became a configuration with replacement characters in it.
 * The configuration here goes through the same strict decoder, and every key it
 * does not know is refused: accepting `maxEvent` beside `maxEvents` leaves the
 * real limit at its default while the operator believes otherwise, and that is
 * how a one-character typo turns a real failure into a green run.
 */

const json = (value) => JSON.stringify(value, null, 2)

const declaration = (name) => json({
  name,
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions: [{ version: 1, schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } }],
})

async function workspace(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

test('an unknown configuration key is refused rather than ignored', () => {
  assert.throws(() => validateConfig({ schemaVersion: '1', modes: 'backward' }), /Unknown configuration key "modes"/)
  assert.throws(() => validateConfig({ schemaVersion: '1', owner: ['a'] }), /Unknown configuration key "owner"/)
})

test('an unknown or out-of-range limit is refused rather than ignored', () => {
  assert.throws(() => validateLimits({ maxEvent: 1 }), /Unknown limit "maxEvent"/)
  assert.throws(() => validateLimits({ maxEvents: 0 }), /must be an integer of 1 or more/)
  assert.throws(() => validateLimits({ maxEvents: 1.5 }), /must be an integer of 1 or more/)
  assert.throws(() => validateLimits({ timeoutMs: -1 }), /must be an integer of 0 or more/)
  assert.deepEqual(validateLimits({}), DEFAULT_LIMITS)
  assert.equal(validateLimits({ timeoutMs: 0 }).timeoutMs, 0)
})

test('the configuration schema version is checked', () => {
  assert.throws(() => validateConfig({}), /Unsupported configuration schemaVersion: missing/)
  assert.throws(() => validateConfig({ schemaVersion: 1 }), /Unsupported configuration schemaVersion/)
  assert.throws(() => validateConfig('not an object'), /must be a JSON object/)
})

test('modes and owners are validated', () => {
  assert.equal(validateMode('full'), 'full')
  assert.throws(() => validateMode(undefined), /A compatibility mode is required/)
  assert.throws(() => validateMode('sideways'), /Unknown compatibility mode "sideways"/)
  assert.equal(validateOwners(undefined), null)
  assert.deepEqual(validateOwners(['b', 'a']), ['a', 'b'])
  assert.throws(() => validateOwners([]), /non-empty array/)
  assert.throws(() => validateOwners(['a', 'a']), /must not repeat/)
  assert.throws(() => validateOwners([' ']), /non-empty string/)
})

test('a configuration file that is not UTF-8 is refused, not decoded leniently', async (t) => {
  const root = await workspace(t, {})
  const path = join(root, 'config.json')
  await writeFile(path, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))
  await assert.rejects(() => loadConfigFile(path), /not valid UTF-8/)
})

test('a configuration file that is not JSON, or absent, is refused', async (t) => {
  const root = await workspace(t, { 'broken.json': '{ "schemaVersion": ' })
  await assert.rejects(() => loadConfigFile(join(root, 'broken.json')), /not valid JSON/)
  await assert.rejects(() => loadConfigFile(join(root, 'absent.json')), /could not be read/)
})

test('a usable configuration file yields a mode, owners and merged limits', async (t) => {
  const root = await workspace(t, {
    'config.json': json({ schemaVersion: '1', mode: 'full', owners: ['team-orders'], limits: { maxEvents: 3 } }),
  })
  const config = await loadConfigFile(join(root, 'config.json'))
  assert.equal(config.mode, 'full')
  assert.deepEqual(config.owners, ['team-orders'])
  assert.equal(config.limits.maxEvents, 3)
  assert.equal(config.limits.maxDepth, DEFAULT_LIMITS.maxDepth)
})

test('a bad configuration file exits 2 with an empty stdout', async (t) => {
  const root = await workspace(t, {
    'registry/a.json': declaration('orders.order_placed'),
    'config.json': json({ schemaVersion: '1', modes: 'backward' }),
  })
  const result = await runCli(['--registry', join(root, 'registry'), '--config', join(root, 'config.json')])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error must leave stdout empty')
  assert.match(result.stderr, /Unknown configuration key "modes"/)
})

test('a run with no mode anywhere is a configuration error, not a default', async (t) => {
  const root = await workspace(t, {
    'registry/a.json': declaration('orders.order_placed'),
    'config.json': json({ schemaVersion: '1', owners: ['team-orders'] }),
  })
  const result = await runCli(['--registry', join(root, 'registry'), '--config', join(root, 'config.json')])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /A compatibility mode is required/)
})

test('the mode in a configuration file is used, and --mode overrides it audibly', async (t) => {
  const root = await workspace(t, {
    'registry/a.json': declaration('orders.order_placed'),
    'config.json': json({ schemaVersion: '1', mode: 'backward' }),
  })
  const fromFile = await runCli(['--registry', join(root, 'registry'), '--config', join(root, 'config.json'), '--json'])
  assert.equal(fromFile.code, 0)
  assert.equal(JSON.parse(fromFile.stdout).summary.mode, 'backward')
  assert.match(fromFile.stderr, /mode backward \(from the configuration file\)/)

  const overridden = await runCli(['--registry', join(root, 'registry'), '--config', join(root, 'config.json'), '--mode', 'full', '--json'])
  assert.equal(overridden.code, 0)
  assert.equal(JSON.parse(overridden.stdout).summary.mode, 'full')
  assert.match(overridden.stderr, /mode full \(from --mode\), overriding "backward" from the configuration file/)
})

test('a limit declared in the configuration file actually reaches the walk', async (t) => {
  // A documented limit the command line never wires through is a limit that
  // does not exist. Two declarations and a maxEvents of 1 must stop the walk.
  const root = await workspace(t, {
    'registry/a.json': declaration('orders.order_placed'),
    'registry/b.json': declaration('billing.invoice_issued'),
    'config.json': json({ schemaVersion: '1', mode: 'backward', limits: { maxEvents: 1 } }),
  })
  const result = await runCli(['--registry', join(root, 'registry'), '--config', join(root, 'config.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['too-many-events'])
  assert.equal(report.summary.checked, 1)
})

test('owners declared in the configuration file actually reach the check', async (t) => {
  const root = await workspace(t, {
    'registry/a.json': declaration('orders.order_placed'),
    'config.json': json({ schemaVersion: '1', mode: 'backward', owners: ['team-somebody-else'] }),
  })
  const result = await runCli(['--registry', join(root, 'registry'), '--config', join(root, 'config.json'), '--json'])
  assert.equal(result.code, 1)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((finding) => finding.ruleId), ['owner-unknown'])
})

test('a command line limit overrides the same limit from the configuration file', async (t) => {
  const root = await workspace(t, {
    'registry/a.json': declaration('orders.order_placed'),
    'registry/b.json': declaration('billing.invoice_issued'),
    'config.json': json({ schemaVersion: '1', mode: 'backward', limits: { maxEvents: 1 } }),
  })
  const result = await runCli([
    '--registry', join(root, 'registry'), '--config', join(root, 'config.json'), '--max-events', '2', '--json',
  ])
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).summary.checked, 2)
})

test('the library refuses an unknown option key', async () => {
  await assert.rejects(() => lintWithUnknownOption(), /Unknown option "registryPath"/)
})

async function lintWithUnknownOption() {
  const { lintEventRegistry } = await import('../src/index.mjs')
  return lintEventRegistry({ registryPath: '.', mode: 'backward' })
}
