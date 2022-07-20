import assert from 'node:assert/strict'
import test from 'node:test'

import { EVENT_KEYS, EVENT_NAME_PATTERN, VERSION_KEYS, validateEventDocument } from '../src/event.mjs'
import { DEFAULT_LIMITS } from '../src/index.mjs'

const limits = DEFAULT_LIMITS

const schema = (properties = { a: { type: 'string' } }, required = ['a']) =>
  ({ type: 'object', additionalProperties: false, required, properties })

const base = (overrides = {}) => ({
  name: 'orders.order_placed',
  owner: 'team-orders',
  producers: ['checkout-api'],
  consumers: ['billing-worker'],
  versions: [{ version: 1, schema: schema() }],
  ...overrides,
})

const rules = (document) => validateEventDocument(document, limits).problems.map((problem) => problem.ruleId)

test('a well-formed declaration produces an event and no problems', () => {
  const { event, problems } = validateEventDocument(base(), limits)
  assert.deepEqual(problems, [])
  assert.equal(event.name, 'orders.order_placed')
  assert.equal(event.owner, 'team-orders')
  assert.equal(event.compatibility, null)
  assert.deepEqual(event.consumers, ['billing-worker'])
  assert.deepEqual(event.producers, ['checkout-api'])
  assert.equal(event.versions.length, 1)
  assert.equal(event.versions[0].index, 0)
})

test('event names must be lower-case domain.event_name', () => {
  for (const name of ['orders.order_placed', 'a.b', 'a1.b2_c3', 'a_b.c_d.e_f']) {
    assert.equal(EVENT_NAME_PATTERN.test(name), true, `${name} should be valid`)
  }
  for (const name of ['OrderPlaced', 'orders', 'orders.', '.orders', 'orders..placed', 'orders.Order', 'orders.order-placed', '1orders.a', 'orders._a']) {
    assert.equal(EVENT_NAME_PATTERN.test(name), false, `${name} should be invalid`)
    assert.deepEqual(rules(base({ name })), ['event-name-invalid'])
  }
  assert.deepEqual(rules(base({ name: `a.${'b'.repeat(200)}` })), ['event-name-invalid'])
  assert.deepEqual(rules(base({ name: undefined })), ['event-name-invalid'])
})

test('every event needs an owner', () => {
  for (const owner of [undefined, '', '   ', 7, null]) {
    assert.deepEqual(rules(base({ owner })), ['owner-missing'], `owner ${JSON.stringify(owner)} was accepted`)
  }
})

test('an unknown key is refused at both levels', () => {
  assert.deepEqual(rules(base({ consumer: ['x'] })), ['event-unknown-key'])
  assert.deepEqual(rules(base({ versions: [{ version: 1, schema: schema(), scheme: {} }] })), ['event-unknown-key'])
  assert.deepEqual([...EVENT_KEYS].sort(), EVENT_KEYS)
  assert.deepEqual([...VERSION_KEYS].sort(), VERSION_KEYS)
})

test('a missing or empty producers or consumers list is a warning, not a silent zero', () => {
  assert.deepEqual(rules(base({ consumers: undefined })), ['consumers-missing'])
  assert.deepEqual(rules(base({ producers: [] })), ['producers-missing'])
  assert.deepEqual(rules(base({ consumers: undefined, producers: undefined })), ['consumers-missing', 'producers-missing'])
})

test('a malformed producers or consumers list is refused', () => {
  assert.deepEqual(rules(base({ consumers: 'billing-worker' })), ['event-malformed'])
  assert.deepEqual(rules(base({ producers: [''] })), ['event-malformed'])
  assert.deepEqual(rules(base({ producers: [1] })), ['event-malformed'])
})

test('service names are de-duplicated and ordered by code unit', () => {
  const { event } = validateEventDocument(base({ consumers: ['b', 'A', 'b', '_c'] }), limits)
  assert.deepEqual(event.consumers, ['A', '_c', 'b'])
})

test('the version sequence must run from 1 with no gaps, in order', () => {
  const v = (version) => ({ version, schema: schema() })
  assert.deepEqual(rules(base({ versions: [v(1), v(1)] })), ['version-duplicate'])
  assert.deepEqual(rules(base({ versions: [v(1), v(3)] })), ['version-sequence-invalid'])
  // Both entries are out of place, and both are named rather than only the
  // first: a reviewer fixing one gap should not have to run the tool again to
  // discover the next.
  assert.deepEqual(rules(base({ versions: [v(2), v(1)] })), ['version-sequence-invalid', 'version-sequence-invalid'])
  assert.deepEqual(rules(base({ versions: [v(0)] })), ['version-sequence-invalid'])
  assert.deepEqual(rules(base({ versions: [v(1.5)] })), ['version-sequence-invalid'])
  assert.deepEqual(rules(base({ versions: [] })), ['versions-missing'])
  assert.deepEqual(rules(base({ versions: undefined })), ['versions-missing'])
  assert.deepEqual(rules(base({ versions: [v(1), v(2), v(3)] })), [])
})

test('a per-event compatibility mode is validated against the mode list', () => {
  assert.equal(validateEventDocument(base({ compatibility: 'full' }), limits).event.compatibility, 'full')
  assert.deepEqual(rules(base({ compatibility: 'sideways' })), ['event-malformed'])
  assert.deepEqual(rules(base({ compatibility: 3 })), ['event-malformed'])
})

test('a document that is not an object is refused outright', () => {
  for (const document of [null, 'text', 42, ['a']]) {
    const { event, problems } = validateEventDocument(document, limits)
    assert.equal(event, null)
    assert.deepEqual(problems.map((problem) => problem.ruleId), ['event-malformed'])
  }
})

test('a version whose schema is unreadable is never compared', () => {
  // The event comes back null, so the caller has nothing to compare. A
  // comparison of schemas the tool could not read would be a guess reported as
  // a verdict.
  const { event, problems } = validateEventDocument(
    base({ versions: [{ version: 1, schema: schema() }, { version: 2, schema: { type: 'strung' } }] }),
    limits,
  )
  assert.equal(event, null)
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['schema-invalid'])
})

test('the maxVersions limit stops the comparison rather than shortening it', () => {
  const { event, problems } = validateEventDocument(
    base({ versions: [{ version: 1, schema: schema() }, { version: 2, schema: schema() }] }),
    { ...limits, maxVersions: 1 },
  )
  assert.equal(event, null)
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['too-many-versions'])
})

test('an owner that is missing does not stop the rest of the event being checked', () => {
  // owner-missing is already an error, so the run fails either way; dropping
  // the event here would hide every compatibility break it also carries.
  const { event, problems } = validateEventDocument(
    base({ owner: undefined, versions: [{ version: 1, schema: schema() }, { version: 2, schema: schema({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']) }] }),
    limits,
  )
  assert.notEqual(event, null)
  assert.equal(event.owner, null)
  assert.equal(event.versions.length, 2)
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['owner-missing'])
})
