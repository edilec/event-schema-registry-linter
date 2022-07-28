import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { isInside, lintEventRegistry } from '../src/index.mjs'

/**
 * Path confinement, checked on real paths on both sides.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the registry resolves out of the tree without ever spelling a
 * traversal, and out-of-root content then reaches a report somebody trusts.
 *
 * The other half of the same defect is a false refusal. A real candidate
 * compared against a root that was never resolved answers "outside" for every
 * file in a registry that sits under a symlinked directory -- which is an
 * ordinary arrangement on a developer machine and in a CI checkout. Both halves
 * are tested here, because a tool that refuses legitimate input is broken in the
 * direction people notice least: it just reports nothing.
 */

const json = (value) => JSON.stringify(value, null, 2)

const declaration = (name) => json({
  name,
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions: [
    { version: 1, schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', description: 'before' } } } },
    { version: 2, schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', description: 'after' } } } },
  ],
})

const SECRET = 'this-declaration-lives-outside-the-registry-root'

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-confine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

test('a symlinked file resolving outside the root is refused and never echoed', async (t) => {
  const outside = await tree(t, { 'secret.json': declaration(`outside.${SECRET.replaceAll('-', '_')}`) })
  const root = await tree(t, { 'ok.json': declaration('orders.order_placed') })
  await symlink(join(outside, 'secret.json'), join(root, 'leak.json'))

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.equal(report.status, 'incomplete')
  const escape = report.findings.find((finding) => finding.ruleId === 'path-escapes-root')
  assert.ok(escape, 'the escaping link was not refused')
  assert.equal(escape.location.file, 'leak.json')
  assert.equal(JSON.stringify(report).includes(SECRET.replaceAll('-', '_')), false, 'out-of-root content reached the report')

  // The legitimate sibling was still read, so the refusal is targeted.
  assert.equal(report.summary.checked, 1)
})

test('a symlinked directory resolving outside the root is refused', async (t) => {
  const outside = await tree(t, { 'nested/secret.json': declaration('outside.secret_event') })
  const root = await tree(t, { 'ok.json': declaration('orders.order_placed') })
  await symlink(join(outside, 'nested'), join(root, 'elsewhere'))

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.filter((finding) => finding.ruleId === 'path-escapes-root').map((finding) => finding.location.file),
    ['elsewhere'],
  )
  assert.equal(JSON.stringify(report).includes('secret_event'), false)
})

test('a registry reached through a symlinked root is read, not refused', async (t) => {
  // This is the false-refusal half. If the root were merely resolved and not
  // realpath'd, every file below would compare "outside" and the run would
  // report an empty registry while looking perfectly healthy.
  const base = await mkdtemp(join(tmpdir(), 'event-registry-confine-base-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'real', 'orders'), { recursive: true })
  await writeFile(join(base, 'real', 'orders', 'placed.json'), declaration('orders.order_placed'))
  await symlink(join(base, 'real'), join(base, 'link'))

  const report = await lintEventRegistry({ registry: join(base, 'link'), mode: 'backward' })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.deepEqual(report.findings.map((finding) => finding.location.file), ['orders/placed.json'])
})

test('a registry under a symlinked ancestor directory is read, not refused', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'event-registry-confine-ancestor-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'real', 'registry'), { recursive: true })
  await writeFile(join(base, 'real', 'registry', 'placed.json'), declaration('orders.order_placed'))
  await symlink(join(base, 'real'), join(base, 'link'))

  const report = await lintEventRegistry({ registry: join(base, 'link', 'registry'), mode: 'backward' })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('a file reachable under two names inside the root is read under both', async (t) => {
  // The de-duplication guard applies to directories, where it stops a symlink
  // loop. Applying it to files would silently drop one of two declarations, and
  // a dropped declaration is a duplicate event name nobody is told about.
  const root = await tree(t, { 'first.json': declaration('orders.order_placed') })
  await symlink(join(root, 'first.json'), join(root, 'second.json'))

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.equal(report.summary.checked, 2)
  assert.deepEqual(
    report.findings.filter((finding) => finding.ruleId === 'event-name-duplicate').map((finding) => finding.location.file),
    ['second.json'],
  )
})

test('a directory symlink loop inside the root terminates', async (t) => {
  const root = await tree(t, { 'nested/placed.json': declaration('orders.order_placed') })
  await symlink(join(root, 'nested'), join(root, 'nested', 'loop'))

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })

  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'pass')
})

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/child.json'), true)
  assert.equal(isInside('/a/root', '/a/rootless/child.json'), false)
  assert.equal(isInside('/a/root', '/a/other'), false)
  assert.equal(isInside('/', '/anything'), true)
})

test('a registry path that is not a readable directory is a configuration error', async (t) => {
  const root = await tree(t, { 'ok.json': declaration('orders.order_placed') })
  await assert.rejects(
    () => lintEventRegistry({ registry: join(root, 'ok.json'), mode: 'backward' }),
    /must be a directory/,
  )
  await assert.rejects(
    () => lintEventRegistry({ registry: join(root, 'absent'), mode: 'backward' }),
    /could not be resolved/,
  )
})
