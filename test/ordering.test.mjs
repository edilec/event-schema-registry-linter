import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { compareFindingRows, lintEventRegistry } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * Ordering, pinned by what the tool emits rather than by how it is spelled.
 *
 * Grepping this project's own source for `.localeCompare(` would not be a
 * determinism test: an `Intl.Collator` drops the forbidden literal and collates
 * exactly as badly, so the grep passes while the order of a report starts
 * depending on the ICU data of whichever host ran it. Every fixture below is
 * chosen so that code-unit order and collation order genuinely disagree --
 * `Ab` `Sa` `_b`, `Z` before `a`, `a-b` before `a_b` -- and every assertion
 * names the exact order the tool must emit. Substitute a collator for any
 * comparator in this tool and these go red.
 */

const CODE_UNIT_FILES = ['Ab.json', 'Sa.json', '_b.json']

const json = (value) => JSON.stringify(value, null, 2)

const declaration = (name, versions) => ({
  name,
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions,
})

const documentationPair = [
  {
    version: 1,
    schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', description: 'before' } } },
  },
  {
    version: 2,
    schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', description: 'after' } } },
  },
]

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-order-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of Object.keys(files).sort()) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, files[path])
  }
  return root
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, stdout: result.stdout }), (error) => ({ code: error.code, stdout: error.stdout }))
}

test('file paths reach the report in code-unit order', async (t) => {
  // A collator orders these `_b.json`, `Ab.json`, `Sa.json`: it sorts the
  // underscore as punctuation before every letter and folds case. Code units
  // put `A` (0x41) before `S` (0x53) before `_` (0x5F).
  const root = await tree(t, Object.fromEntries(CODE_UNIT_FILES.map((file, index) =>
    [file, json(declaration(`d${index}.e${index}`, documentationPair))])))

  const report = await lintEventRegistry({ registry: root, mode: 'full' })
  assert.deepEqual(report.findings.map((finding) => finding.location.file), CODE_UNIT_FILES)

  const result = await runCli(['--registry', root, '--mode', 'full', '--json'])
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((finding) => finding.location.file), CODE_UNIT_FILES)
})

test('pointers within one file reach the report in code-unit order', async (t) => {
  // `a-b` and `a_b` are the pair a collator orders the other way round: it
  // weights the connector `_` (0x5F) below the dash `-` (0x2D); code units do
  // the opposite. Two sorts have to agree for this to hold: the path sort in
  // compareSchemas, which decides the order changes are produced in, and the
  // pointer key of the finding sort, which decides the order they are reported
  // in. Reverse either and this flips.
  const schema = (description) => ({
    type: 'object',
    additionalProperties: false,
    required: ['a-b', 'a_b'],
    properties: { 'a-b': { type: 'string', description }, 'a_b': { type: 'string', description } },
  })
  const root = await tree(t, { 'events.json': json(declaration('d.e', [
    { version: 1, schema: schema('before') },
    { version: 2, schema: schema('after') },
  ])) })

  const report = await lintEventRegistry({ registry: root, mode: 'full' })
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/versions/1/schema/properties/a-b',
    '/versions/1/schema/properties/a_b',
  ])
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['documentation-changed', 'documentation-changed'])
})

test('two findings at one pointer are ordered by message in code-unit order', async (t) => {
  // `required` naming two properties that do not exist produces two findings
  // with the same file, the same pointer and the same rule id, so only the
  // message key can separate them -- and the two names disagree between code
  // units and collation.
  const root = await tree(t, { 'events.json': json(declaration('d.e', [
    {
      version: 1,
      schema: { type: 'object', additionalProperties: false, required: ['a-b', 'a_b'], properties: { a: { type: 'string' } } },
    },
  ])) })

  const report = await lintEventRegistry({ registry: root, mode: 'full' })
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['schema-invalid', 'schema-invalid'])
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/versions/0/schema/required',
    '/versions/0/schema/required',
  ])
  assert.deepEqual(report.findings.map((finding) => finding.evidence), [undefined, undefined])
  assert.match(report.findings[0].message, /"a-b"/)
  assert.match(report.findings[1].message, /"a_b"/)
})

test('directory entries are walked in code-unit order', async (t) => {
  // `Zmirror` is a symlink to the sibling directory `areal`. The walk visits a
  // directory once, under whichever name it reached first, so the name that
  // reaches the report says which order the listing was walked in: code units
  // put `Z` (0x5A) before `a` (0x61), a collator puts `areal` first.
  const root = await tree(t, { 'areal/buried.json': json(declaration('d.e', documentationPair)) })
  await symlink('areal', join(root, 'Zmirror'))

  const report = await lintEventRegistry({ registry: root, mode: 'full' })
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['Zmirror/buried.json'],
    'the walk visited the sibling directories in an order that is not by code unit',
  )
})

test('the earlier file by code unit is the original and the later one is the duplicate', async (t) => {
  // Which of two files declaring one event name is the original and which is
  // the duplicate is decided by the order the documents were sorted into, and
  // the wrong one being named is a report that sends a reviewer to the wrong
  // file. `Ab.json` and `_b.json` disagree: code units put `A` (0x41) before
  // `_` (0x5F), a collator sorts the underscore as punctuation and puts `_b`
  // first.
  const declared = (file) => [file, json(declaration('orders.order_placed', documentationPair))]
  const root = await tree(t, Object.fromEntries([declared('Ab.json'), declared('_b.json')]))

  const report = await lintEventRegistry({ registry: root, mode: 'none' })
  const duplicates = report.findings.filter((finding) => finding.ruleId === 'event-name-duplicate')
  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].location.file, '_b.json')
  assert.equal(
    duplicates[0].message,
    'Event name "orders.order_placed" is already declared in Ab.json. '
    + "Two declarations of one name make the registry's answer depend on which file a reader opened.",
  )

  const result = await runCli(['--registry', root, '--mode', 'none', '--json'])
  assert.equal(result.code, 1)
  const emitted = JSON.parse(result.stdout).findings.filter((finding) => finding.ruleId === 'event-name-duplicate')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].location.file, '_b.json')
})

test('a schema truncated at maxFields reads the fields that come first by code unit', async (t) => {
  // The field walk stops at the limit, so its order decides which fields were
  // read at all -- not merely the order they are reported in. `Zb` and `a_b`
  // disagree: code units put `Z` (0x5A) before `a` (0x61), a collator folds
  // case and puts `a_b` first. With one field of budget, code-unit order reads
  // the valid `Zb` and reports only the limit; collation order reads the
  // malformed `a_b` instead and emits a schema-invalid finding with it.
  const root = await tree(t, { 'events.json': json(declaration('d.e', [
    {
      version: 1,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['Zb'],
        properties: { Zb: { type: 'string' }, a_b: { type: 'strung' } },
      },
    },
  ])) })

  const report = await lintEventRegistry({ registry: root, mode: 'full', limits: { maxFields: 1 } })
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['too-many-fields'])
  assert.equal(report.findings[0].location.pointer, '/versions/0/schema')
  assert.equal(report.status, 'incomplete')

  const result = await runCli(['--registry', root, '--mode', 'full', '--max-fields', '1', '--json'])
  assert.equal(result.code, 2)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((finding) => finding.ruleId), ['too-many-fields'])
})

test('two findings that differ only in evidence are ordered by it', async (t) => {
  // Two unknown keys sharing a 60-character prefix produce the same pointer and
  // the same message, because both are bounded excerpts of the key, while the
  // evidence -- bounded at 80 -- still tells them apart. The fifth sort key is
  // what decides their order; without it the report falls back to the order the
  // document validator happened to walk the keys in. `Zb` and `a_b` disagree:
  // code units put `Z` (0x5A) before `a` (0x61), a collator folds case and puts
  // `a_b` first.
  const prefix = 'x'.repeat(60)
  const root = await tree(t, { 'events.json': json({
    ...declaration('d.e', documentationPair),
    [`${prefix}Zb`]: 1,
    [`${prefix}a_b`]: 2,
  }) })

  const report = await lintEventRegistry({ registry: root, mode: 'full' })
  const unknown = report.findings.filter((finding) => finding.ruleId === 'event-unknown-key')
  assert.deepEqual(unknown.map((finding) => finding.evidence), [`${prefix}Zb`, `${prefix}a_b`])
  assert.equal(unknown[0].location.pointer, unknown[1].location.pointer, 'the fixture no longer ties on pointer')
  assert.equal(unknown[0].message, unknown[1].message, 'the fixture no longer ties on message')

  const result = await runCli(['--registry', root, '--mode', 'full', '--json'])
  assert.equal(result.code, 1)
  assert.deepEqual(
    JSON.parse(result.stdout).findings
      .filter((finding) => finding.ruleId === 'event-unknown-key')
      .map((finding) => finding.evidence),
    [`${prefix}Zb`, `${prefix}a_b`],
  )
})

test('every key of the finding order is compared by code unit', () => {
  // One pair per key, each spelled so that a collator disagrees with code
  // units. Substituting a collator for any one of the five comparisons flips
  // exactly one of these assertions.
  const row = (overrides) => ({
    location: { file: overrides.file ?? 'a.json', pointer: overrides.pointer ?? '/p' },
    ruleId: overrides.ruleId ?? 'r',
    message: overrides.message ?? 'm',
    evidence: overrides.evidence ?? 'e',
  })
  for (const key of ['file', 'pointer', 'ruleId', 'message', 'evidence']) {
    const dash = row({ [key]: key === 'pointer' ? '/a-b' : 'a-b' })
    const underscore = row({ [key]: key === 'pointer' ? '/a_b' : 'a_b' })
    assert.equal(compareFindingRows(dash, underscore), -1, `${key} is not compared by code unit`)
    assert.equal(compareFindingRows(underscore, dash), 1, `${key} is not compared by code unit`)
  }
  assert.equal(compareFindingRows(row({}), row({})), 0)
})

test('a missing pointer or evidence sorts as an empty string rather than throwing', () => {
  const withPointer = { location: { file: 'a.json', pointer: '/x' }, ruleId: 'r', message: 'm' }
  const without = { location: { file: 'a.json' }, ruleId: 'r', message: 'm' }
  assert.equal(compareFindingRows(without, withPointer), -1)
  assert.equal(compareFindingRows(withPointer, without), 1)

  const withEvidence = { location: { file: 'a.json' }, ruleId: 'r', message: 'm', evidence: 'e' }
  assert.equal(compareFindingRows(without, withEvidence), -1)
  assert.equal(compareFindingRows(withEvidence, without), 1)
  assert.equal(compareFindingRows(without, without), 0)
})

test('the whole human report is byte-identical to the order written down here', async (t) => {
  // The human report is the artifact a reviewer reads. Pinning it in full
  // catches an ordering change that slipped past every field-by-field
  // assertion above.
  const root = await tree(t, Object.fromEntries(CODE_UNIT_FILES.map((file, index) =>
    [file, json(declaration(`d${index}.e${index}`, documentationPair))])))

  const result = await runCli(['--registry', root, '--mode', 'full'])
  assert.equal(result.code, 0)
  assert.deepEqual(
    result.stdout.split(String.fromCharCode(10)).filter((line) => line.startsWith('INFO')),
    CODE_UNIT_FILES.map((file) =>
      `INFO    ${file}/versions/1/schema/properties/a documentation-changed `
      + 'v1 -> v2: a changed only in documentation keywords ($comment, description, examples, title), '
      + 'which breaks nothing in any mode.'),
  )
})

test('the same registry produces byte-identical output twice', async (t) => {
  const root = await tree(t, Object.fromEntries(CODE_UNIT_FILES.map((file, index) =>
    [file, json(declaration(`d${index}.e${index}`, documentationPair))])))

  const first = await runCli(['--registry', root, '--mode', 'full', '--json'])
  const second = await runCli(['--registry', root, '--mode', 'full', '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
})
