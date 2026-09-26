import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * The command line surface, and both shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * empty and the message goes to stderr. An input that could not be read means
 * the run had a subject and failed to obtain evidence about it, so stdout
 * carries an `incomplete` report naming which input was not read. A consumer
 * that pipes stdout has to handle both, which is only possible if the tool is
 * consistent about which is which.
 */

const json = (value) => JSON.stringify(value, null, 2)

const schema = (properties, required) => ({ type: 'object', additionalProperties: false, required, properties })

const declaration = (name, versions) => json({
  name,
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions,
})

const CLEAN = declaration('orders.order_placed', [{ version: 1, schema: schema({ a: { type: 'string' } }, ['a']) }])

const BREAKING = declaration('billing.invoice_issued', [
  { version: 1, schema: schema({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']) },
  { version: 2, schema: schema({ a: { type: 'string' } }, ['a']) },
])

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-cli-'))
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

test('--help prints usage on stdout and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /^event-schema-registry-linter/)
    assert.match(result.stdout, /--registry DIR/)
    assert.match(result.stdout, /There is no default mode/)
    assert.equal(result.stderr, '')
  }
})

test('a registry that satisfies the mode exits 0', async (t) => {
  const root = await tree(t, { 'a.json': CLEAN })
  const result = await runCli(['--registry', root, '--mode', 'backward'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /status pass\./)
})

test('a registry that does not satisfy the mode exits 1', async (t) => {
  const root = await tree(t, { 'b.json': BREAKING })
  const result = await runCli(['--registry', root, '--mode', 'backward'])
  assert.equal(result.code, 1)
  assert.match(result.stdout, /status fail\./)
  assert.match(result.stdout, /required-field-removed/)
})

test('--json writes a parseable report and nothing else to stdout', async (t) => {
  const root = await tree(t, { 'b.json': BREAKING })
  const result = await runCli(['--registry', root, '--mode', 'backward', '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'event-schema-registry-linter')
  assert.equal(report.status, 'fail')
  assert.equal(typeof report.summary.checked, 'number')
  // Diagnostics never contaminate the stream a consumer parses.
  assert.equal(result.stdout.trimEnd().endsWith('}'), true)
  assert.match(result.stderr, /^mode backward/)
})

test('an unknown option exits 2 with an empty stdout', async () => {
  const result = await runCli(['--registry', '.', '--mode', 'backward', '--strict'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--strict"/)
})

test('a repeated option exits 2 rather than taking the last value', async (t) => {
  const root = await tree(t, { 'a.json': CLEAN })
  const result = await runCli(['--registry', root, '--mode', 'backward', '--mode', 'none'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--mode was given more than once/)
})

test('a missing required option or value exits 2 with an empty stdout', async () => {
  for (const [args, pattern] of [
    [['--mode', 'backward'], /--registry is required/],
    [['--registry'], /--registry requires a value/],
    [['--registry', '.', '--mode'], /--mode requires a value/],
  ]) {
    const result = await runCli(args)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, pattern)
  }
})

test('an unusable mode or registry exits 2 with an empty stdout', async () => {
  for (const [args, pattern] of [
    [['--registry', '.', '--mode', 'sideways'], /Unknown compatibility mode "sideways"/],
    [['--registry', '/definitely/not/here', '--mode', 'backward'], /could not be resolved/],
  ]) {
    const result = await runCli(args)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, pattern)
  }
})

test('a limit flag refuses a non-integer and states its own floor', async () => {
  for (const [args, pattern] of [
    [['--max-events', 'many'], /--max-events requires an integer of 1 or more/],
    [['--max-events', '0'], /--max-events requires an integer of 1 or more/],
    [['--timeout-ms', '-5'], /--timeout-ms requires a value/],
  ]) {
    const result = await runCli(['--registry', '.', '--mode', 'backward', ...args])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, pattern)
  }
})

test('an input that could not be read exits 2 with an incomplete report on stdout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'broken.json'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))

  const result = await runCli(['--registry', root, '--mode', 'backward', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['event-not-utf8'])
  assert.equal(report.findings[0].location.file, 'broken.json')
  assert.match(result.stderr, /incomplete: 1 piece\(s\) of evidence were not obtained/)
})

test('an empty registry exits 2 rather than reporting a pass on no evidence', async (t) => {
  const root = await tree(t, {})
  const result = await runCli(['--registry', root, '--mode', 'backward', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['no-events-found'])
})

test('no location in the report is an absolute host path', async (t) => {
  const root = await tree(t, { 'nested/b.json': BREAKING })
  const result = await runCli(['--registry', root, '--mode', 'backward', '--json'])
  const report = JSON.parse(result.stdout)
  assert.equal(report.findings.length > 0, true)
  for (const finding of report.findings) {
    assert.equal(finding.location.file.startsWith('/'), false)
    assert.equal(result.stdout.includes(root), false, 'the host path of the registry reached stdout')
  }
})

test('the example registries behave as the README says they do', async () => {
  const clean = await runCli(['--registry', 'examples/registry', '--config', 'examples/linter.config.json'])
  assert.equal(clean.code, 0)
  assert.match(clean.stdout, /status pass\./)

  const broken = await runCli(['--registry', 'examples/registry-broken', '--mode', 'backward', '--json'])
  assert.equal(broken.code, 1)
  const report = JSON.parse(broken.stdout)
  assert.equal(report.status, 'fail')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'required-field-removed'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'owner-missing'))
})
