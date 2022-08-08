import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, lintEventRegistry } from '../src/index.mjs'
import { REGISTRY_ROOT, SKIPPED_DIRECTORIES, readRegistry } from '../src/registry.mjs'

/** The walk itself: what it reads, in what order, and where it stops. */

const json = (value) => JSON.stringify(value, null, 2)

const declaration = (name) => json({
  name,
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions: [{ version: 1, schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } }],
})

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-walk-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return realpath(root)
}

const read = (realRoot, overrides = {}, clock = () => 0) =>
  readRegistry({ realRoot, limits: { ...DEFAULT_LIMITS, ...overrides }, clock })

test('only *.json files are read, and relative paths use forward slashes', async (t) => {
  const realRoot = await tree(t, {
    'a.json': declaration('a.one'),
    'nested/b.json': declaration('b.two'),
    'notes.md': '# not a declaration',
    'c.json.bak': 'not read either',
  })
  const { documents, problems, candidates } = await read(realRoot)
  assert.deepEqual(documents.map((entry) => entry.file), ['a.json', 'nested/b.json'])
  assert.deepEqual(problems, [])
  assert.equal(candidates, 2)
})

test('a registry with no declaration files reports none found', async (t) => {
  const realRoot = await tree(t, { 'notes.md': 'nothing here' })
  const { documents, candidates } = await read(realRoot)
  assert.deepEqual(documents, [])
  assert.equal(candidates, 0)
})

test('dependency and history directories are never walked', async (t) => {
  const realRoot = await tree(t, {
    'a.json': declaration('a.one'),
    'node_modules/pkg/schema.json': declaration('vendor.event'),
    '.git/objects/x.json': declaration('git.event'),
  })
  const { documents } = await read(realRoot)
  assert.deepEqual(documents.map((entry) => entry.file), ['a.json'])
  assert.deepEqual([...SKIPPED_DIRECTORIES].sort(), SKIPPED_DIRECTORIES)
})

test('the walk reports its own limits rather than truncating quietly', async (t) => {
  const realRoot = await tree(t, { 'a.json': declaration('a.one'), 'b.json': declaration('b.two') })

  const capped = await read(realRoot, { maxEvents: 1 })
  assert.deepEqual(capped.problems.map((problem) => problem.ruleId), ['too-many-events'])
  assert.equal(capped.problems[0].file, REGISTRY_ROOT)
  assert.equal(capped.documents.length, 1)

  const large = await read(realRoot, { maxFileBytes: 16 })
  assert.deepEqual(large.problems.map((problem) => problem.ruleId), ['event-too-large', 'event-too-large'])
  assert.equal(large.documents.length, 0)
})

test('the time budget is injected, enforced and reported', async (t) => {
  const realRoot = await tree(t, { 'a.json': declaration('a.one'), 'b.json': declaration('b.two') })

  // A clock that jumps past the budget after the first reading.
  let readings = 0
  const clock = () => (readings++ === 0 ? 0 : 1000)
  const { documents, problems } = await readRegistry({
    realRoot,
    limits: { ...DEFAULT_LIMITS, timeoutMs: 10 },
    clock,
  })
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['time-budget-exceeded'])
  assert.match(problems[0].message, /timeoutMs budget of 10/)
  assert.equal(documents.length, 1, 'the walk always attempts at least one entry')
})

test('a clock that never advances lets the whole walk finish', async (t) => {
  const realRoot = await tree(t, { 'a.json': declaration('a.one'), 'b.json': declaration('b.two') })
  const { documents, problems } = await read(realRoot, { timeoutMs: 1 })
  assert.deepEqual(problems, [])
  assert.equal(documents.length, 2)
})

test('a zero budget leaves no time at all, even for a clock that never advances', async (t) => {
  // The budget is `clock() < deadline`, not `<=`. With timeoutMs 0 the deadline
  // is the reading the walk started from, so a clock standing still has no time
  // either -- which is what makes `--timeout-ms 0` provable from outside the
  // process. Every other fixture here uses a clock that genuinely moved past
  // the deadline, and those pass under `<=` as well.
  const realRoot = await tree(t, { 'a.json': declaration('a.one'), 'b.json': declaration('b.two') })

  const { documents, problems } = await read(realRoot, { timeoutMs: 0 })
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['time-budget-exceeded'])
  assert.equal(documents.length, 1, 'the walk always attempts at least one entry')

  const report = await lintEventRegistry({
    registry: realRoot,
    mode: 'backward',
    limits: { timeoutMs: 0 },
    clock: () => 0,
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unexamined, 1)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['time-budget-exceeded'])
})

test('an undecodable or unparseable file is a problem, not a document', async (t) => {
  const realRoot = await tree(t, { 'bad-bytes.json': Buffer.from([0x7b, 0xff]), 'bad-json.json': '{' })
  const { documents, problems } = await read(realRoot)
  assert.deepEqual(documents, [])
  assert.deepEqual(problems.map((problem) => [problem.file, problem.ruleId]), [
    ['bad-bytes.json', 'event-not-utf8'],
    ['bad-json.json', 'event-not-json'],
  ])
  assert.match(problems[1].message, /not valid JSON/)
})

test('the walk refuses to descend past maxDepth and says which directory', async (t) => {
  const realRoot = await tree(t, { 'top.json': declaration('a.one'), 'one/two/deep.json': declaration('b.two') })
  const { documents, problems } = await read(realRoot, { maxDepth: 1 })
  assert.deepEqual(problems.map((problem) => [problem.file, problem.ruleId]), [['one/two', 'directory-too-deep']])
  assert.deepEqual(documents.map((entry) => entry.file), ['top.json'])
})

test('the walk is a pure read: nothing under the root is written', async (t) => {
  const realRoot = await tree(t, { 'a.json': declaration('a.one') })
  const before = await import('node:fs/promises').then((fs) => fs.stat(join(realRoot, 'a.json')))
  await lintEventRegistry({ registry: realRoot, mode: 'backward' })
  const after = await import('node:fs/promises').then((fs) => fs.stat(join(realRoot, 'a.json')))
  assert.equal(before.mtimeMs, after.mtimeMs)
  assert.equal(before.size, after.size)
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(realRoot))
  assert.deepEqual(entries, ['a.json'])
})
