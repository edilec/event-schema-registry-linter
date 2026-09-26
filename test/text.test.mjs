import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTROL_CLASSES, EXCERPT_LIMIT, byCodeUnit, decodeUtf8, escapePointerSegment, sanitize } from '../src/text.mjs'

/** The primitives every other module depends on, exercised directly. */

test('byCodeUnit orders by UTF-16 code unit, not by collation', () => {
  // Each pair is one a collator gets the other way round.
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('README', 'assets'), -1)
  assert.equal(byCodeUnit('MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.deepEqual(['a', 'Z', '_b'].sort(byCodeUnit), ['Z', '_b', 'a'])
})

test('decodeUtf8 refuses undecodable bytes instead of guessing', () => {
  assert.deepEqual(decodeUtf8(Buffer.from('hello', 'utf8')), { ok: true, text: 'hello' })
  assert.deepEqual(decodeUtf8(Buffer.from([0xff, 0xfe])), { ok: false, reason: 'not-utf8' })
  assert.deepEqual(decodeUtf8(Buffer.from([0xc3])), { ok: false, reason: 'not-utf8' })
})

test('a literal replacement character is content, not a decoding failure', () => {
  // Inferring "not UTF-8" from a U+FFFD in decoded text cannot tell a broken
  // file from one that legitimately contains the character, and that confusion
  // has let an unreadable input report a pass elsewhere in this catalog.
  const decoded = decodeUtf8(Buffer.from(`a${String.fromCodePoint(0xfffd)}b`, 'utf8'))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text.length, 3)
})

test('a byte order mark is consumed rather than becoming content', () => {
  const decoded = decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))
  assert.deepEqual(decoded, { ok: true, text: 'a' })
})

test('sanitize removes every class it claims to remove', () => {
  for (const [label, codePoints] of Object.entries(CONTROL_CLASSES)) {
    for (const codePoint of codePoints) {
      const hostile = String.fromCodePoint(codePoint)
      const cleaned = sanitize(`before${hostile}after`)
      assert.equal(cleaned.includes(hostile), false, `${label} U+${codePoint.toString(16)} survived`)
      assert.equal(cleaned, 'before after')
    }
  }
})

test('sanitize flattens, trims and bounds', () => {
  assert.equal(sanitize('  a   b  '), 'a b')
  assert.equal(sanitize(''), '')
  assert.equal(sanitize(12), '12')
  assert.equal(sanitize('x'.repeat(EXCERPT_LIMIT)), 'x'.repeat(EXCERPT_LIMIT))
  assert.equal(sanitize('x'.repeat(EXCERPT_LIMIT + 1)), `${'x'.repeat(EXCERPT_LIMIT)}...`)
  assert.equal(sanitize('abcdef', 3), 'abc...')
  assert.throws(() => sanitize('a', -1), TypeError)
  assert.throws(() => sanitize('a', 1.5), TypeError)
})

test('escapePointerSegment escapes RFC 6901 and sanitises the result', () => {
  assert.equal(escapePointerSegment('a/b'), 'a~1b')
  assert.equal(escapePointerSegment('a~b'), 'a~0b')
  assert.equal(escapePointerSegment('a~/b'), 'a~0~1b')
  assert.equal(escapePointerSegment(`a${String.fromCodePoint(0x85)}b`), 'a b')
})

test('a character the sanitiser keeps is genuinely kept', () => {
  // The class is not "everything unusual". A zero-width space is invisible but
  // it is content, and an emoji in a description is not an attack.
  const zeroWidth = String.fromCodePoint(0x200b)
  assert.equal(sanitize(`a${zeroWidth}b`).includes(zeroWidth), true)
  assert.equal(sanitize('naive café'), 'naive café')
})
