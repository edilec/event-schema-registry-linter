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
  // the opposite. The production order comes from the property-key sort in the
  // comparison, the report order from the pointer key of the finding sort.
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

test('every key of the finding order is compared by code unit', () => {
  // One pair per key, each spelled so that a collator disagrees with code
  // units. Substituting a collator for any one of the four comparisons flips
  // exactly one of these assertions.
  const row = (overrides) => ({
    location: { file: overrides.file ?? 'a.json', pointer: overrides.pointer ?? '/p' },
    ruleId: overrides.ruleId ?? 'r',
    message: overrides.message ?? 'm',
  })
  for (const key of ['file', 'pointer', 'ruleId', 'message']) {
    const dash = row({ [key]: key === 'pointer' ? '/a-b' : 'a-b' })
    const underscore = row({ [key]: key === 'pointer' ? '/a_b' : 'a_b' })
    assert.equal(compareFindingRows(dash, underscore), -1, `${key} is not compared by code unit`)
    assert.equal(compareFindingRows(underscore, dash), 1, `${key} is not compared by code unit`)
  }
  assert.equal(compareFindingRows(row({}), row({})), 0)
})

test('a missing pointer sorts as an empty string rather than throwing', () => {
  const withPointer = { location: { file: 'a.json', pointer: '/x' }, ruleId: 'r', message: 'm' }
  const without = { location: { file: 'a.json' }, ruleId: 'r', message: 'm' }
  assert.equal(compareFindingRows(without, withPointer), -1)
  assert.equal(compareFindingRows(withPointer, without), 1)
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
