import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CHANGE_KINDS, DEFAULT_LIMITS, INCOMPLETE_RULES, RULE_SEVERITY } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The documented catalog, asserted against the source in both directions.
 *
 * This is a **documentation** check, and it is deliberately labelled as one. It
 * cannot be the severity guard: a table in the source, a table in a document
 * and a map in a test are three declarations, and one coordinated edit satisfies
 * all three. `test/severity-behaviour.test.mjs` is the guard -- it drives every
 * rule through the real entry point and asserts an exit code.
 *
 * What this test is worth is the other failure: a rule added, renamed or
 * retired in the source and never written down, so the catalog a reader trusts
 * quietly stops describing the tool.
 */

const CATALOG = join(projectDirectory, 'docs', 'rule-catalog.md')
const ROW = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \| (restrictive|expansive|neutral|documentation|-) \| (consumer|producer|-) \|/

async function documentedRows() {
  const text = await readFile(CATALOG, 'utf8')
  const rows = new Map()
  for (const line of text.split(String.fromCharCode(10))) {
    const match = ROW.exec(line)
    if (match === null) continue
    assert.equal(rows.has(match[1]), false, `${match[1]} is documented twice`)
    rows.set(match[1], { severity: match[2], incomplete: match[3] === 'yes', direction: match[4], side: match[5] })
  }
  return rows
}

test('every rule in the source is documented, and every documented rule exists', async () => {
  const rows = await documentedRows()
  assert.deepEqual([...rows.keys()].sort(), Object.keys(RULE_SEVERITY).sort())
})

test('the documented severity matches the source table for every rule', async () => {
  const rows = await documentedRows()
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(rows.get(ruleId).severity, severity, `${ruleId} is documented as ${rows.get(ruleId).severity}`)
  }
})

test('the documented incomplete column matches INCOMPLETE_RULES in both directions', async () => {
  const rows = await documentedRows()
  const documented = [...rows.entries()].filter(([, row]) => row.incomplete).map(([ruleId]) => ruleId)
  assert.deepEqual(documented.sort(), [...INCOMPLETE_RULES].sort())
})

test('the documented direction and side match CHANGE_KINDS in both directions', async () => {
  const rows = await documentedRows()
  for (const [ruleId, row] of rows) {
    const kind = CHANGE_KINDS[ruleId]
    if (kind === undefined) {
      assert.equal(row.direction, '-', `${ruleId} is not a change kind but is documented with a direction`)
      assert.equal(row.side, '-', `${ruleId} is not a change kind but is documented with a side`)
      continue
    }
    assert.equal(row.direction, kind.direction, `${ruleId} direction`)
    assert.equal(row.side, kind.side ?? '-', `${ruleId} side`)
  }
  for (const ruleId of Object.keys(CHANGE_KINDS)) {
    assert.ok(rows.has(ruleId), `${ruleId} is a change kind with no documented row`)
  }
})

test('every rule that marks a run incomplete exists in the severity table', () => {
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} marks a run incomplete but has no severity`)
  }
  assert.equal(new Set(INCOMPLETE_RULES).size, INCOMPLETE_RULES.length)
})

test('every documented limit exists with the documented default and floor', async () => {
  const text = await readFile(CATALOG, 'utf8')
  const rows = new Map()
  for (const line of text.split(String.fromCharCode(10))) {
    const match = /^\| `(\w+)` \| `(--[a-z-]+)` \| (\d+) \| (\d+) \|/.exec(line)
    if (match !== null) rows.set(match[1], { flag: match[2], default: Number(match[3]), floor: Number(match[4]) })
  }
  assert.deepEqual([...rows.keys()].sort(), Object.keys(DEFAULT_LIMITS).sort())
  for (const [name, row] of rows) {
    assert.equal(row.default, DEFAULT_LIMITS[name], `${name} default`)
    assert.equal(row.floor, name === 'timeoutMs' ? 0 : 1, `${name} floor`)
  }
})

test('every documented limit flag is accepted by the command line', async () => {
  const text = await readFile(join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs'), 'utf8')
  const catalog = await readFile(CATALOG, 'utf8')
  for (const line of catalog.split(String.fromCharCode(10))) {
    const match = /^\| `\w+` \| `(--[a-z-]+)` \|/.exec(line)
    if (match !== null) assert.ok(text.includes(`'${match[1]}'`), `${match[1]} is documented but not parsed`)
  }
})

test('every rule id is stable kebab case', () => {
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.match(ruleId, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  }
})
