import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHANGE_KINDS,
  DOC_KEYWORDS,
  JSON_TYPES,
  MODES,
  SCHEMA_KEYWORDS,
  collectFields,
  compareSchemas,
  describePath,
  expandTypes,
  modeRefuses,
  validateSchema,
} from '../src/compare.mjs'
import { DEFAULT_LIMITS } from '../src/index.mjs'

const limits = DEFAULT_LIMITS
const at = (pointer = '') => pointer

const obj = (properties, required, extra = {}) => ({
  type: 'object', additionalProperties: false, required, properties, ...extra,
})

const kinds = (before, after) => compareSchemas(collectFields(before), collectFields(after)).map((change) => change.kind)

test('expandTypes treats integer as a strict subtype of number', () => {
  assert.deepEqual(expandTypes('string'), ['string'])
  assert.deepEqual(expandTypes('number'), ['integer', 'number'])
  assert.deepEqual(expandTypes('integer'), ['integer'])
  assert.deepEqual(expandTypes(['string', 'null']), ['null', 'string'])
  assert.deepEqual(expandTypes(['number', 'integer']), ['integer', 'number'])
})

test('number to integer is a narrowing and integer to number is a widening', () => {
  assert.deepEqual(kinds(obj({ a: { type: 'number' } }, ['a']), obj({ a: { type: 'integer' } }, ['a'])), ['field-type-narrowed'])
  assert.deepEqual(kinds(obj({ a: { type: 'integer' } }, ['a']), obj({ a: { type: 'number' } }, ['a'])), ['field-type-widened'])
})

test('an unrelated type change is both a narrowing and a widening', () => {
  // `string` to `integer` loses every value the old contract promised and adds
  // every value the new one does, so both halves are true and both are
  // reported. A mode that refuses either direction catches it.
  assert.deepEqual(
    kinds(obj({ a: { type: 'string' } }, ['a']), obj({ a: { type: 'integer' } }, ['a'])),
    ['field-type-narrowed', 'field-type-widened'],
  )
})

test('a removed subtree is reported once, at the parent', () => {
  const before = obj({ a: obj({ b: { type: 'string' }, c: { type: 'string' } }, ['b', 'c']) }, ['a'])
  const after = obj({ d: { type: 'string' } }, ['d'])
  assert.deepEqual(kinds(before, after), ['required-field-removed', 'required-field-added'])
})

test('nested and array fields are compared at their own paths', () => {
  const before = obj({ tags: { type: 'array', items: { type: 'string' } } }, ['tags'])
  const after = obj({ tags: { type: 'array', items: { type: 'integer' } } }, ['tags'])
  const changes = compareSchemas(collectFields(before), collectFields(after))
  assert.deepEqual(changes.map((change) => change.path), ['/properties/tags/items', '/properties/tags/items'])
  assert.deepEqual(changes.map((change) => change.kind), ['field-type-narrowed', 'field-type-widened'])
})

test('additionalProperties defaults to true, as in JSON Schema', () => {
  const open = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
  const closed = obj({ a: { type: 'string' } }, ['a'])
  assert.equal(collectFields(open).get('').additionalProperties, true)
  assert.deepEqual(kinds(open, closed), ['additional-properties-restricted'])
  assert.deepEqual(kinds(closed, open), ['additional-properties-relaxed'])
})

test('a documentation keyword change is the only change reported', () => {
  for (const keyword of DOC_KEYWORDS) {
    const before = obj({ a: { type: 'string', [keyword]: 'one' } }, ['a'])
    const after = obj({ a: { type: 'string', [keyword]: 'two' } }, ['a'])
    assert.deepEqual(kinds(before, after), ['documentation-changed'], `${keyword} was not treated as documentation`)
  }
})

test('adding or removing a documentation keyword is still only documentation', () => {
  const bare = obj({ a: { type: 'string' } }, ['a'])
  const titled = obj({ a: { type: 'string', title: 'A' } }, ['a'])
  assert.deepEqual(kinds(bare, titled), ['documentation-changed'])
  assert.deepEqual(kinds(titled, bare), ['documentation-changed'])
})

test('identical schemas produce no change at all', () => {
  const schema = obj({ a: { type: 'string', description: 'same' } }, ['a'])
  assert.deepEqual(kinds(schema, schema), [])
})

test('modeRefuses maps direction to mode and refuses an unknown mode', () => {
  assert.deepEqual(MODES, ['backward', 'forward', 'full', 'none'])
  assert.equal(modeRefuses('backward', 'restrictive'), true)
  assert.equal(modeRefuses('backward', 'expansive'), false)
  assert.equal(modeRefuses('forward', 'expansive'), true)
  assert.equal(modeRefuses('forward', 'restrictive'), false)
  assert.equal(modeRefuses('full', 'restrictive'), true)
  assert.equal(modeRefuses('full', 'expansive'), true)
  assert.equal(modeRefuses('none', 'restrictive'), false)
  assert.equal(modeRefuses('none', 'expansive'), false)
  for (const mode of MODES) {
    assert.equal(modeRefuses(mode, 'documentation'), false, `${mode} refused a documentation edit`)
    assert.equal(modeRefuses(mode, 'neutral'), false)
  }
  assert.throws(() => modeRefuses('sideways', 'restrictive'), /Unknown compatibility mode/)
})

test('every change kind declares a direction the modes understand', () => {
  for (const [kind, meta] of Object.entries(CHANGE_KINDS)) {
    assert.ok(['restrictive', 'expansive', 'neutral', 'documentation'].includes(meta.direction), kind)
    assert.ok(meta.side === null || ['consumer', 'producer'].includes(meta.side), kind)
  }
})

test('validateSchema refuses an unknown keyword rather than ignoring it', () => {
  const { problems } = validateSchema({ ...obj({ a: { type: 'string' } }, ['a']), requried: ['a'] }, at(), limits)
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['schema-unknown-keyword'])
  assert.equal(problems[0].pointer, '/requried')
  assert.equal(problems[0].evidence, 'requried')
})

test('validateSchema refuses a malformed node', () => {
  const cases = [
    [{}, 'must declare a type'],
    [{ type: 'strung' }, 'Unsupported type'],
    [{ type: [] }, 'must not be empty'],
    [{ type: ['string', 'string'] }, 'must not repeat'],
    [{ type: 'object', additionalProperties: 'yes' }, 'must be a boolean'],
    [{ type: 'string', additionalProperties: false }, 'applies only to a node whose type includes object'],
    [{ type: 'object', required: 'a' }, 'must be an array'],
    [{ type: 'string', items: { type: 'string' } }, 'applies only to a node whose type includes array'],
    [{ type: 'object', properties: [] }, 'must be a JSON object'],
    [{ type: 'object', required: ['a'], properties: { b: { type: 'string' } } }, 'not declared in properties'],
    [{ type: 'object', required: ['a'] }, 'declares no properties'],
    [{ type: 'object', required: ['a', 'a'], properties: { a: { type: 'string' } } }, 'same property twice'],
    ['not an object', 'must be a JSON object'],
  ]
  for (const [node, expected] of cases) {
    const { problems } = validateSchema(node, at(), limits)
    assert.ok(problems.length > 0, `${JSON.stringify(node)} was accepted`)
    assert.ok(
      problems.some((problem) => problem.message.includes(expected)),
      `${JSON.stringify(node)} produced ${JSON.stringify(problems.map((problem) => problem.message))}`,
    )
    assert.ok(problems.every((problem) => ['schema-invalid', 'schema-unknown-keyword'].includes(problem.ruleId)))
  }
})

test('validateSchema accepts every documented keyword and type', () => {
  const node = {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'array', items: { type: JSON_TYPES } } },
    title: 'T',
    description: 'D',
    examples: [1],
    $comment: 'C',
  }
  const { problems } = validateSchema(node, at(), limits)
  assert.deepEqual(problems, [])
  assert.deepEqual([...SCHEMA_KEYWORDS].sort(), SCHEMA_KEYWORDS)
})

test('validateSchema enforces its depth and field limits with one finding each', () => {
  const deep = obj({ a: obj({ b: { type: 'string' } }, ['b']) }, ['a'])
  const depth = validateSchema(deep, at(), { ...limits, maxSchemaDepth: 1 })
  assert.deepEqual(depth.problems.map((problem) => problem.ruleId), ['schema-too-deep'])
  assert.equal(depth.counters.depthExceeded, true)

  const wide = obj({ a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } }, ['a'])
  const fields = validateSchema(wide, at(), { ...limits, maxFields: 2 })
  assert.deepEqual(fields.problems.map((problem) => problem.ruleId), ['too-many-fields'])
  assert.equal(fields.counters.fieldsExceeded, true)
})

test('describePath names a field the way a reviewer would', () => {
  assert.equal(describePath(''), 'the payload root')
  assert.equal(describePath('/properties/order_id'), 'order_id')
  assert.equal(describePath('/properties/customer/properties/id'), 'customer.id')
  assert.equal(describePath('/properties/tags/items'), 'tags.[]')
})
