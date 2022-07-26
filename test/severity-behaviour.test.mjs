import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY, formatReport, lintEventRegistry } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * Severity, pinned by what a run of the tool actually does.
 *
 * `RULE_SEVERITY` is the single source of truth and stays that way. What it
 * cannot do is defend itself: asserting the table against the documented
 * catalog, or against a copy of the same values written out by hand in a test,
 * is three declarations agreeing with each other, and one coordinated edit
 * agrees with itself and passes.
 *
 * So every rule below is driven through the real entry point on a real registry
 * and what is asserted is the outcome: the status, the severity word the human
 * report prints, and the exit code of the process. For the rules whose severity
 * decides the verdict, a downgrade or an upgrade moves the exit code -- an error
 * that becomes a warning turns fail/1 into pass/0, and a warning that becomes an
 * error turns pass/0 into fail/1.
 *
 * The rules that also mark the run incomplete exit 2 whichever severity they
 * carry, because missing evidence is never a pass. Both halves are asserted for
 * them: the exit code that does not move, and the severity word that does.
 * Those assertions are also what defends the incomplete flag itself -- remove
 * it and the run reports fail/1 or pass/0 instead of incomplete/2.
 */

const LIMIT_FLAGS = {
  maxDepth: '--max-depth',
  maxEvents: '--max-events',
  maxFields: '--max-fields',
  maxFileBytes: '--max-file-bytes',
  maxSchemaDepth: '--max-schema-depth',
  maxVersions: '--max-versions',
  timeoutMs: '--timeout-ms',
}

const json = (value) => JSON.stringify(value, null, 2)

const obj = (properties, required, extra = {}) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
  ...extra,
})

const ONE_VERSION = [{ version: 1, schema: obj({ a: { type: 'string' } }, ['a']) }]

const event = (overrides = {}) => ({
  name: 'orders.order_placed',
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions: ONE_VERSION,
  ...overrides,
})

const pair = (first, second) => [{ version: 1, schema: first }, { version: 2, schema: second }]

/** An event whose two versions differ only in the way under test. */
const evolving = (first, second) => event({ versions: pair(first, second) })

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-severity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of Object.keys(files).sort()) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, files[path])
  }
  return root
}

/** A registry holding exactly one event declaration. */
const only = (t, declaration, rest = {}) => tree(t, { 'orders.json': json(declaration) }).then((root) => ({ root, ...rest }))

/** A second, entirely clean declaration, so a fixture can hold a valid file. */
const CLEAN = json(event({ name: 'billing.invoice_issued' }))

const CASES = [
  {
    ruleId: 'additional-properties-relaxed',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    mode: 'forward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' } }, ['a']),
      obj({ a: { type: 'string' } }, ['a'], { additionalProperties: true }),
    )),
  },
  {
    ruleId: 'additional-properties-restricted',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' } }, ['a'], { additionalProperties: true }),
      obj({ a: { type: 'string' } }, ['a']),
    )),
  },
  {
    ruleId: 'change-outside-mode',
    severity: 'info',
    status: 'pass',
    exit: 0,
    mode: 'forward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
      obj({ a: { type: 'string' } }, ['a']),
    )),
  },
  {
    ruleId: 'consumers-missing',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    mode: 'backward',
    build: (t) => only(t, { ...event(), consumers: undefined }),
  },
  {
    ruleId: 'directory-too-deep',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => tree(t, { 'ok.json': CLEAN, 'deep/deeper/buried.json': CLEAN })
      .then((root) => ({ root, limits: { maxDepth: 1 } })),
  },
  {
    ruleId: 'documentation-changed',
    severity: 'info',
    status: 'pass',
    exit: 0,
    mode: 'full',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string', description: 'before' } }, ['a']),
      obj({ a: { type: 'string', description: 'after' } }, ['a']),
    )),
  },
  {
    ruleId: 'event-malformed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event({ compatibility: 'sideways' })),
  },
  {
    ruleId: 'event-name-duplicate',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => tree(t, { 'a.json': json(event()), 'b.json': json(event()) }).then((root) => ({ root })),
  },
  {
    ruleId: 'event-name-invalid',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event({ name: 'OrderPlaced' })),
  },
  {
    ruleId: 'event-not-json',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => tree(t, { 'orders.json': '{ "name": ' }).then((root) => ({ root })),
  },
  {
    ruleId: 'event-not-utf8',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => tree(t, { 'orders.json': Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) }).then((root) => ({ root })),
  },
  {
    ruleId: 'event-too-large',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => only(t, event(), { limits: { maxFileBytes: 32 } }),
  },
  {
    ruleId: 'event-unknown-key',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, { ...event(), consumer: ['billing-worker'] }),
  },
  {
    ruleId: 'event-unreadable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'event-registry-severity-locked-'))
      const locked = join(root, 'locked')
      await mkdir(locked, { recursive: true })
      await writeFile(join(locked, 'buried.json'), CLEAN)
      await writeFile(join(root, 'ok.json'), CLEAN)
      t.after(async () => {
        await chmod(locked, 0o755).catch(() => {})
        await rm(root, { recursive: true, force: true })
      })
      await chmod(locked, 0o000)
      // A process that can read the directory anyway -- root, or a filesystem
      // with no POSIX modes -- would make the assertions below meaningless.
      const enforced = await readdir(locked).then(() => false, () => true)
      if (!enforced) return { skip: 'the filesystem did not enforce the mode change' }
      return { root }
    },
  },
  {
    ruleId: 'field-type-narrowed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'number' } }, ['a']),
      obj({ a: { type: 'integer' } }, ['a']),
    )),
  },
  {
    ruleId: 'field-type-widened',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'forward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'integer' } }, ['a']),
      obj({ a: { type: 'number' } }, ['a']),
    )),
  },
  {
    ruleId: 'no-events-found',
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => tree(t, { 'notes/README.txt': 'not a declaration' }).then((root) => ({ root })),
  },
  {
    ruleId: 'optional-field-added',
    severity: 'info',
    status: 'pass',
    exit: 0,
    mode: 'full',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' } }, ['a']),
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']),
    )),
  },
  {
    ruleId: 'optional-field-made-required',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'forward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']),
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
    )),
  },
  {
    ruleId: 'optional-field-removed',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    mode: 'backward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']),
      obj({ a: { type: 'string' } }, ['a']),
    )),
  },
  {
    ruleId: 'owner-missing',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, { ...event(), owner: undefined }),
  },
  {
    ruleId: 'owner-unknown',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event(), { owners: ['team-somebody-else'] }),
  },
  {
    ruleId: 'path-escapes-root',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: async (t) => {
      const outside = await tree(t, { 'secret.json': json(event({ name: 'secret.not_yours' })) })
      const root = await tree(t, { 'ok.json': CLEAN })
      await symlink(join(outside, 'secret.json'), join(root, 'leak.json'))
      return { root }
    },
  },
  {
    ruleId: 'producers-missing',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    mode: 'backward',
    build: (t) => only(t, { ...event(), producers: undefined }),
  },
  {
    ruleId: 'required-field-added',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'forward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' } }, ['a']),
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
    )),
  },
  {
    ruleId: 'required-field-made-optional',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']),
    )),
  },
  {
    ruleId: 'required-field-removed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
      obj({ a: { type: 'string' } }, ['a']),
    )),
  },
  {
    ruleId: 'schema-invalid',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event({ versions: [{ version: 1, schema: { type: 'strung' } }] })),
  },
  {
    ruleId: 'schema-too-deep',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => only(t, event(), { limits: { maxSchemaDepth: 1 } }),
  },
  {
    ruleId: 'schema-unknown-keyword',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event({
      versions: [{ version: 1, schema: { ...obj({ a: { type: 'string' } }, ['a']), requried: ['a'] } }],
    })),
  },
  {
    ruleId: 'time-budget-exceeded',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => only(t, event(), { limits: { timeoutMs: 0 } }),
  },
  {
    ruleId: 'too-many-events',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => tree(t, { 'a.json': json(event()), 'b.json': CLEAN })
      .then((root) => ({ root, limits: { maxEvents: 1 } })),
  },
  {
    ruleId: 'too-many-fields',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => only(
      t,
      event({ versions: [{ version: 1, schema: obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']) }] }),
      { limits: { maxFields: 1 } },
    ),
  },
  {
    ruleId: 'too-many-versions',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    mode: 'backward',
    build: (t) => only(t, evolving(
      obj({ a: { type: 'string' } }, ['a']),
      obj({ a: { type: 'string' } }, ['a']),
    ), { limits: { maxVersions: 1 } }),
  },
  {
    ruleId: 'version-duplicate',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event({
      versions: [
        { version: 1, schema: obj({ a: { type: 'string' } }, ['a']) },
        { version: 1, schema: obj({ a: { type: 'string' } }, ['a']) },
      ],
    })),
  },
  {
    ruleId: 'version-sequence-invalid',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event({
      versions: [
        { version: 1, schema: obj({ a: { type: 'string' } }, ['a']) },
        { version: 3, schema: obj({ a: { type: 'string' } }, ['a']) },
      ],
    })),
  },
  {
    ruleId: 'versions-missing',
    severity: 'error',
    status: 'fail',
    exit: 1,
    mode: 'backward',
    build: (t) => only(t, event({ versions: [] })),
  },
]

async function runCli(t, fixture, mode) {
  const args = [cli, '--registry', fixture.root, '--mode', mode]
  for (const [name, value] of Object.entries(fixture.limits ?? {})) args.push(LIMIT_FLAGS[name], String(value))
  if (fixture.owners !== undefined) {
    const directory = await mkdtemp(join(tmpdir(), 'event-registry-severity-config-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'config.json')
    await writeFile(path, json({ schemaVersion: '1', owners: fixture.owners }))
    args.push('--config', path)
  }
  return execFileAsync(process.execPath, args, { cwd: projectDirectory })
    .then((result) => ({ code: 0, stdout: result.stdout }), (error) => ({ code: error.code, stdout: error.stdout }))
}

for (const testCase of CASES) {
  test(`${testCase.ruleId} is emitted as ${testCase.severity} and the run exits ${testCase.exit}`, async (t) => {
    const fixture = await testCase.build(t)
    if (fixture.skip !== undefined) {
      t.skip(fixture.skip)
      return
    }

    const report = await lintEventRegistry({
      registry: fixture.root,
      mode: testCase.mode,
      limits: fixture.limits ?? {},
      ...(fixture.owners === undefined ? {} : { owners: fixture.owners }),
    })

    // The fixture isolates the rule, so nothing else can be deciding the status
    // or the exit code below.
    assert.deepEqual([...new Set(report.findings.map((finding) => finding.ruleId))], [testCase.ruleId])
    for (const finding of report.findings) {
      assert.equal(finding.severity, testCase.severity, `${testCase.ruleId} was emitted as ${finding.severity}`)
    }

    // The severity as the human report prints it, and as the summary counts it.
    const printed = formatReport(report)
      .split(String.fromCharCode(10))
      .filter((line) => line.includes(` ${testCase.ruleId} `))
    assert.ok(printed.length > 0, `${testCase.ruleId} never reached a report line`)
    for (const line of printed) {
      assert.equal(line.startsWith(testCase.severity.toUpperCase()), true, `report line: ${line}`)
    }
    assert.equal(report.summary.errors > 0, testCase.severity === 'error')
    assert.equal(report.summary.warnings > 0, testCase.severity === 'warning')
    assert.equal(report.summary.info > 0, testCase.severity === 'info')

    // The outcome a downgrade, an upgrade, or a dropped incomplete flag moves.
    assert.equal(report.status, testCase.status)
    const result = await runCli(t, fixture, testCase.mode)
    assert.equal(result.code, testCase.exit, `the CLI exited ${result.code}`)
    assert.match(result.stdout, new RegExp(`status ${testCase.status}\\.`))
  })
}

test('every rule in the severity table is pinned by a run of the tool', () => {
  // The table is the source of truth; this is the list of rules a run actually
  // emitted. A rule added to the table without a run that emits it is a rule
  // whose severity nobody watched happen.
  assert.deepEqual(CASES.map((testCase) => testCase.ruleId).sort(), Object.keys(RULE_SEVERITY).sort())
  assert.equal(new Set(CASES.map((testCase) => testCase.ruleId)).size, CASES.length)
})

test('the three severities differ in what they do, not only in what they are called', () => {
  // The whole reason severity is worth pinning: two of these outcomes are a
  // refusal and one is not.
  const outcomes = new Map()
  for (const testCase of CASES) {
    outcomes.set(testCase.severity, [...(outcomes.get(testCase.severity) ?? []), `${testCase.status}/${testCase.exit}`])
  }
  assert.deepEqual([...new Set(outcomes.get('error'))].sort(), ['fail/1', 'incomplete/2'])
  assert.deepEqual([...new Set(outcomes.get('warning'))].sort(), ['incomplete/2', 'pass/0'])
  assert.deepEqual([...new Set(outcomes.get('info'))].sort(), ['pass/0'])
})
