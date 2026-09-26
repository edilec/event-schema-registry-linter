import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CONTROL_CLASSES, formatReport, lintEventRegistry, parseFailureDetail, sanitize } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'event-schema-registry-linter.mjs')

/**
 * Sanitising, pinned on every surface an untrusted string can reach.
 *
 * Stripping C0 and the two line separators is not sanitising. `U+0085` (NEL)
 * and `U+009B` (the 8-bit CSI) are not ECMAScript whitespace and are not
 * escaped by `JSON.stringify`, so a class that stops at C0 lets both reach
 * stdout intact, where NEL forges a report line and CSI opens an escape
 * sequence. `U+202E` reverses everything displayed after it, so a field named
 * one thing is read as another.
 *
 * Every class is driven through an **identifier** here -- an event name, an
 * owner, a declared consumer, a schema property name, a schema keyword, an
 * event document key, and a file name on disk -- not only through an excerpt
 * field. One tool in this catalog sanitised its excerpts carefully and let a
 * page id containing a newline forge whole lines in its report.
 */

const CLASSES = Object.freeze({
  'C0 NUL': 0x00,
  'C0 line feed': 0x0a,
  'C0 escape': 0x1b,
  'DEL': 0x7f,
  'C1 NEL': 0x85,
  'C1 CSI': 0x9b,
  'line separator': 0x2028,
  'paragraph separator': 0x2029,
  'bidi left-to-right mark': 0x200e,
  'bidi right-to-left override': 0x202e,
  'bidi first-strong isolate': 0x2069,
})

/** Every code point the sanitiser claims to remove, from the exported classes. */
const EVERY_CODE_POINT = Object.values(CONTROL_CLASSES).flat()

const json = (value) => JSON.stringify(value, null, 2)

/** Every string anywhere in a parsed report, object keys included. */
function* strings(value) {
  if (typeof value === 'string') {
    yield value
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) yield* strings(entry)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      yield key
      yield* strings(entry)
    }
  }
}

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'event-registry-sanitise-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

/** A registry that puts `hostile` into every identifier the report can carry. */
function hostileRegistry(hostile) {
  const field = `total${hostile}minor`
  const schema = (properties, required) => ({ type: 'object', additionalProperties: false, required, properties })
  return {
    'owner.json': json({
      name: 'orders.order_placed',
      owner: `team${hostile}orders`,
      producers: ['checkout-api'],
      consumers: ['billing-worker'],
      versions: [{ version: 1, schema: schema({ a: { type: 'string' } }, ['a']) }],
    }),
    'fields.json': json({
      name: 'billing.invoice_issued',
      owner: 'team-orders',
      producers: [`checkout${hostile}api`],
      consumers: [`billing${hostile}worker`],
      versions: [
        { version: 1, schema: schema({ a: { type: 'string' }, [field]: { type: 'string' } }, ['a', field]) },
        { version: 2, schema: schema({ a: { type: 'string' } }, ['a']) },
      ],
    }),
    'keyword.json': json({
      name: 'shipping.parcel_shipped',
      owner: 'team-orders',
      [`extra${hostile}key`]: 1,
      producers: ['checkout-api'],
      consumers: ['billing-worker'],
      versions: [{ version: 1, schema: { ...schema({ a: { type: 'string' } }, ['a']), [`req${hostile}uired`]: [] } }],
    }),
    'name.json': json({
      name: `payments.payment${hostile}taken`,
      owner: 'team-orders',
      producers: ['checkout-api'],
      consumers: ['billing-worker'],
      versions: [{ version: 1, schema: schema({ a: { type: 'string' } }, ['a']) }],
    }),
  }
}

for (const [label, codePoint] of Object.entries(CLASSES)) {
  const hostile = String.fromCodePoint(codePoint)

  test(`${label} (U+${codePoint.toString(16).padStart(4, '0').toUpperCase()}) never reaches output through an identifier`, async (t) => {
    const root = await tree(t, hostileRegistry(hostile))
    const report = await lintEventRegistry({ registry: root, mode: 'backward', owners: ['team-orders'] })

    // Every surface the character was planted in produced a finding, so this
    // is not passing because nothing looked at the hostile input.
    const rules = new Set(report.findings.map((finding) => finding.ruleId))
    for (const expected of ['owner-unknown', 'required-field-removed', 'event-unknown-key', 'schema-unknown-keyword', 'event-name-invalid']) {
      assert.ok(rules.has(expected), `${expected} was never reached, so ${label} was not exercised there`)
    }
    const breakage = report.findings.find((finding) => finding.ruleId === 'required-field-removed').breakage
    assert.deepEqual(breakage.candidates, ['billing worker'])

    // Nothing in the report carries the character, anywhere. The serialised
    // text is only half of that claim and cannot be the whole of it:
    // JSON.stringify escapes C0 unconditionally, so searching it for NUL, a
    // line feed or ESC is false however badly the sanitiser is broken. What a
    // consumer acts on is the parsed document, so every string in it -- values
    // and keys alike -- is searched as well, and that half fails for all eleven
    // classes.
    const serialised = JSON.stringify(report)
    assert.equal(serialised.includes(hostile), false, `${label} survived into the JSON report`)
    const parsed = [...strings(JSON.parse(serialised))]
    assert.ok(parsed.length > report.findings.length, 'the walk over the parsed report found almost nothing')
    for (const value of parsed) {
      assert.equal(value.includes(hostile), false, `${label} survived into the parsed JSON report`)
    }

    // Nor does any line of the human report. The line count is the other half
    // of the same assertion and the one that matters for the line feed, whose
    // whole trick is that the report is itself line-separated: one line per
    // finding, one blank, two summary lines, one trailing newline.
    const lines = formatReport(report).split(String.fromCharCode(10))
    for (const line of lines) {
      assert.equal(line.includes(hostile), false, `${label} survived into a human report line`)
    }
    assert.equal(report.status, 'fail')
    assert.equal(lines.length, report.findings.length + 4, `${label} forged a line in the human report`)
  })
}

test('every code point the sanitiser lists is actually removed', () => {
  // The exported classes are a claim. This drives each one through sanitize and
  // through the pointer escaper, which is the other place an identifier is
  // rendered.
  for (const codePoint of EVERY_CODE_POINT) {
    const hostile = String.fromCodePoint(codePoint)
    assert.equal(sanitize(`a${hostile}b`).includes(hostile), false, `U+${codePoint.toString(16)} survived sanitize`)
  }
})

test('a hostile character in a file name is stripped from location.file', async (t) => {
  // The path is an identifier the registry author chose, exactly like an event
  // name. NUL cannot appear in a POSIX file name, so the class exercised here
  // is the C1 NEL that forges a line on a terminal.
  const hostile = String.fromCodePoint(0x85)
  const root = await tree(t, {
    [`or${hostile}ders.json`]: json({
      name: 'orders.order_placed',
      owner: 'team-orders',
      producers: ['checkout-api'],
      consumers: ['billing-worker'],
      versions: [{ version: 1, schema: { type: 'object', required: ['a'], properties: {} } }],
    }),
  })

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  assert.equal(report.findings.length > 0, true)
  for (const finding of report.findings) {
    assert.equal(finding.location.file, 'or ders.json')
    assert.equal(finding.location.file.includes(hostile), false)
  }
  assert.equal(formatReport(report).includes(hostile), false)
})

test('the command line writes no hostile character to stdout', async (t) => {
  const hostile = String.fromCodePoint(0x9b)
  const root = await tree(t, hostileRegistry(hostile))

  for (const args of [[], ['--json']]) {
    const result = await execFileAsync(
      process.execPath,
      [cli, '--registry', root, '--mode', 'backward', ...args],
      { cwd: projectDirectory },
    ).then((value) => value, (error) => error)
    assert.equal(result.stdout.includes(hostile), false, `the 8-bit CSI reached stdout for ${args.join(' ') || 'the human report'}`)
  }
})

test('an excerpt is bounded as well as sanitised', () => {
  assert.equal(sanitize('x'.repeat(400)).length, 163)
  assert.equal(sanitize('x'.repeat(400)).endsWith('...'), true)
  assert.equal(sanitize('short'), 'short')
  assert.throws(() => sanitize('x', 0), TypeError)
})

/**
 * A parse failure must not quote the document, and that is a separate claim
 * from sanitising.
 *
 * V8 reports a parse failure two ways and one of them embeds the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, or a
 * ten-character prefix followed by `"..."`. Sanitising does not touch it --
 * the quoted copy carries no control characters and sits at the front, well
 * inside the excerpt limit -- so a registry file short enough to be only a
 * credential was reproduced in full in the report. The canary below is a
 * published AWS documentation placeholder, not a live key.
 */
const CANARY = 'AKIAIOSFODNN7EXAMPLE'

/**
 * A leak is still a leak when only a prefix is quoted, so every prefix down to
 * eight characters is checked. Eight is below V8's ten-character truncation.
 */
function assertNoCanary(streams) {
  for (const [name, text] of Object.entries(streams)) {
    for (let length = CANARY.length; length >= 8; length -= 1) {
      assert.equal(
        text.includes(CANARY.slice(0, length)),
        false,
        `${name} echoed the first ${length} characters of the unparseable document`,
      )
    }
  }
}

const runCli = (args) => execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
  .then((value) => value, (error) => error)

test('an unparseable event document is reported without echoing its contents', async (t) => {
  const root = await tree(t, { 'orders/placed.json': CANARY })

  for (const args of [[], ['--json']]) {
    const result = await runCli(['--registry', root, '--mode', 'backward', ...args])
    assertNoCanary({ stdout: result.stdout, stderr: result.stderr })
  }

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  const finding = report.findings.find((entry) => entry.ruleId === 'event-not-json')
  assert.ok(finding, 'the unparseable file produced no finding, so nothing was exercised')
  assertNoCanary({ report: JSON.stringify(report), human: formatReport(report) })
  assert.equal(finding.message, "This file is not valid JSON: unexpected token 'A' at the start of the document")
})

test('a truncated event document still reports where parsing stopped', async (t) => {
  const root = await tree(t, { 'orders/placed.json': `{"name": "${CANARY}", ` })

  const report = await lintEventRegistry({ registry: root, mode: 'backward' })
  const finding = report.findings.find((entry) => entry.ruleId === 'event-not-json')
  assert.ok(finding, 'the truncated file produced no finding')
  assertNoCanary({ report: JSON.stringify(report), human: formatReport(report) })
  assert.match(finding.message, /at position \d+ \(line \d+ column \d+\)$/)
})

test('an unparseable configuration file is reported without echoing its contents', async (t) => {
  const root = await tree(t, { 'linter.config.json': CANARY, 'orders/placed.json': json({ name: 'a.b', owner: 'o', versions: [] }) })

  const result = await runCli(['--registry', root, '--config', join(root, 'linter.config.json')])

  assert.equal(result.code, 2)
  assertNoCanary({ stdout: result.stdout, stderr: result.stderr })
  assert.match(result.stderr, /Configuration file is not valid JSON/)
})

test('parseFailureDetail keeps the position and drops the quoted document', () => {
  const capture = (source) => {
    try {
      JSON.parse(source)
      return null
    } catch (error) {
      return error
    }
  }

  const quoting = capture(CANARY)
  assert.equal(quoting.message.includes(CANARY), true, 'V8 no longer quotes the input; this guard needs revisiting')
  assert.equal(parseFailureDetail(quoting), "unexpected token 'A' at the start of the document")

  // A longer document is quoted as a ten-character prefix, which a check for
  // the whole string would miss entirely.
  const truncated = capture('password=hunter2-correct-horse')
  assert.equal(truncated.message.includes('password=h'), true)
  assert.equal(parseFailureDetail(truncated), "unexpected token 'p' at the start of the document")

  assert.match(parseFailureDetail(capture('{"a": 1, ')), /at position \d+ \(line \d+ column \d+\)$/)
  assert.equal(parseFailureDetail(capture('')), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail(new Error('unrecognised shape')), 'the document could not be parsed as JSON')

  // The token is one character of untrusted input, so callers sanitise the
  // result; the detail itself does not pretend to.
  const hostile = capture(`${String.fromCodePoint(0x9b)}x`)
  assert.equal(sanitize(parseFailureDetail(hostile)).includes(String.fromCodePoint(0x9b)), false)
})
