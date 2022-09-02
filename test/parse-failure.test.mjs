/**
 * The parse-failure detail must never carry the registry document back out.
 *
 * Every failure here is captured from a real `JSON.parse`, never hand-written.
 * The defect being pinned is that V8 puts the document ITSELF inside the
 * message, so a synthetic message would not exercise it at all.
 *
 * The first case is the one that fixes the ordering. A document whose own text
 * reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so a helper that
 * looks for the offset BEFORE recognising the quoting shape finds that phrase
 * inside the quoted span and slices the document straight back out. Reverting
 * to position-first ordering fails this file.
 *
 * The last two cases pin the other direction. A helper that answered the
 * generic sentence for everything would pass every leak assertion here while
 * destroying every diagnostic, so the position, line and column are asserted to
 * SURVIVE, and the empty-input message is asserted to pass through unchanged.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'

/** A genuine V8 `SyntaxError` for `source`, or a failure saying the fixture went stale. */
function capture(source) {
  try {
    JSON.parse(source)
  } catch (error) {
    if (error instanceof SyntaxError) return error
    throw error
  }
  throw new Error(`the fixture ${JSON.stringify(source)} parsed, so nothing was exercised`)
}

test('a document that reads like a position marker is not sliced back out', () => {
  const document = 'at position 1'
  const error = capture(document)
  assert.equal(
    error.message.includes(document),
    true,
    'V8 no longer quotes the input back, so this guard needs revisiting',
  )

  const detail = parseFailureDetail(error)
  assert.equal(detail.includes('"'), false, `a quoted snippet survived: ${detail}`)
  assert.equal(detail.includes(document), false, `the document survived: ${detail}`)

  // Not leaking is only half of it. The quoting shape must have been RECOGNISED,
  // which is what pins the ordering: a position-first helper either slices the
  // document back out, or -- where a closing guard catches that -- throws the
  // diagnostic away and answers the generic sentence. Both fail this line.
  assert.equal(
    detail.startsWith("unexpected token 'a'"),
    true,
    `the quoting shape was not recognised first; the detail was: ${detail}`,
  )
})

test('a document that is nothing but a credential-shaped token stays out of the detail', () => {
  const token = 'AKIAIOSFODNN7EXAMPLE'
  const error = capture(token)
  assert.equal(
    error.message.includes(token),
    true,
    'V8 no longer quotes the input back, so this guard needs revisiting',
  )

  const detail = parseFailureDetail(error)
  assert.equal(detail.includes(token), false, `the token survived: ${detail}`)
  assert.equal(detail.includes('"'), false, `a quoted snippet survived: ${detail}`)
})

test('no four-character window of a long document’s sensitive prefix reaches the detail', () => {
  // V8 quotes only a ten-character prefix of a long document, which a check for
  // the whole string would miss entirely.
  const secret = 'Zk7Qw2Xp9R'
  const error = capture(`${secret}${'v'.repeat(500)}`)
  assert.equal(
    error.message.includes(secret),
    true,
    'V8 no longer quotes a prefix of the input, so this guard needs revisiting',
  )

  const detail = parseFailureDetail(error)
  for (let index = 0; index + 4 <= secret.length; index += 1) {
    const window = secret.slice(index, index + 4)
    assert.equal(detail.includes(window), false, `${window} survived into: ${detail}`)
  }
})

test('a quoted span containing a newline is still recognised as the quoting shape', () => {
  const error = capture('}x\n')
  assert.equal(error.message.includes('\n'), true, 'the fixture no longer spans a newline')
  assert.match(error.message, /is not valid JSON$/)

  const detail = parseFailureDetail(error)
  assert.equal(detail.startsWith("unexpected token '}'"), true, detail)
  assert.equal(detail.includes('"'), false, `a quoted snippet survived: ${detail}`)
  assert.equal(detail.includes('\n'), false, `a newline survived: ${detail}`)
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  const detail = parseFailureDetail(capture('{"token": "AKIAIOSFODNN7EXAMPLE", '))

  assert.equal(detail.startsWith('Expected double-quoted property name in JSON'), true, detail)
  assert.match(detail, /at position 34 \(line 1 column 35\)$/)
  assert.equal(detail.includes('AKIA'), false, `the document survived: ${detail}`)
})

test('an exhausted document passes through unchanged', () => {
  assert.equal(parseFailureDetail(capture('')), 'Unexpected end of JSON input')
})

test('a message in no recognised shape falls back to the generic sentence', () => {
  assert.equal(parseFailureDetail(new Error('unrecognised shape')), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})
