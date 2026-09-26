/**
 * The payload schema subset, and the compatibility comparison between two
 * consecutive versions of one event.
 *
 * The subset is deliberately small. A registry linter that accepted the whole
 * of JSON Schema would have to decide compatibility for `oneOf`, `$ref` and
 * `patternProperties`, and every one of those answers would be a guess. What is
 * supported here is exactly what can be compared without guessing, and
 * `docs/rule-catalog.md` names what is not.
 */

import { byCodeUnit, escapePointerSegment, sanitize } from './text.mjs'

/** The primitive JSON types a field may declare. */
export const JSON_TYPES = Object.freeze(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])

/**
 * Keywords that carry documentation and nothing else.
 *
 * A change confined to these keywords is a documentation edit. It can never
 * break a producer or a consumer, so it is reported as `info` and fails no
 * compatibility mode. This is the acceptance case for the tool, and it is the
 * reason the keyword set is a frozen list rather than a heuristic: if a
 * contract-bearing keyword were ever added to it, a real break would go quiet.
 */
export const DOC_KEYWORDS = Object.freeze(['$comment', 'description', 'examples', 'title'])

/** Every keyword a schema node may carry. Anything else is a typo, and refused. */
export const SCHEMA_KEYWORDS = Object.freeze(
  [...DOC_KEYWORDS, 'additionalProperties', 'items', 'properties', 'required', 'type'].sort(byCodeUnit),
)

/** The compatibility modes. `none` records every change and fails nothing. */
export const MODES = Object.freeze(['backward', 'forward', 'full', 'none'])

/**
 * The kinds of change this tool can detect, each with the direction it moves
 * the contract in and the side most likely to notice it first.
 *
 * Modes are defined by **direction**, which is the only definition that stays
 * self-consistent once both halves of a rollout are considered:
 *
 * - A **restrictive** change takes something away or tightens what the contract
 *   permits: a required field disappears or becomes optional, a type narrows to
 *   a strict subset, extra properties stop being allowed.
 * - An **expansive** change adds a demand or broadens what the contract emits:
 *   a new required field appears, an optional field becomes required, a type
 *   widens to a strict superset.
 *
 * `backward` refuses restrictive changes, `forward` refuses expansive ones,
 * `full` refuses both, `none` refuses neither.
 *
 * The `side` is the participant whose declarations put it first in line, and it
 * is a **candidate**, not a verdict: the registry knows who declared themselves
 * a producer or a consumer, never who is actually on the wire.
 */
export const CHANGE_KINDS = Object.freeze({
  'additional-properties-relaxed': Object.freeze({ direction: 'expansive', side: 'consumer' }),
  'additional-properties-restricted': Object.freeze({ direction: 'restrictive', side: 'producer' }),
  'documentation-changed': Object.freeze({ direction: 'documentation', side: null }),
  'field-type-narrowed': Object.freeze({ direction: 'restrictive', side: 'producer' }),
  'field-type-widened': Object.freeze({ direction: 'expansive', side: 'consumer' }),
  'optional-field-added': Object.freeze({ direction: 'neutral', side: null }),
  'optional-field-made-required': Object.freeze({ direction: 'expansive', side: 'producer' }),
  'optional-field-removed': Object.freeze({ direction: 'restrictive', side: 'consumer' }),
  'required-field-added': Object.freeze({ direction: 'expansive', side: 'producer' }),
  'required-field-made-optional': Object.freeze({ direction: 'restrictive', side: 'consumer' }),
  'required-field-removed': Object.freeze({ direction: 'restrictive', side: 'consumer' }),
})

/** Does `mode` refuse a change moving in `direction`? */
export function modeRefuses(mode, direction) {
  if (!MODES.includes(mode)) throw new TypeError(`Unknown compatibility mode "${mode}"`)
  if (direction === 'neutral' || direction === 'documentation') return false
  if (mode === 'full') return true
  if (mode === 'backward') return direction === 'restrictive'
  if (mode === 'forward') return direction === 'expansive'
  return false
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The declared type as a set of primitive types.
 *
 * `integer` is a strict subtype of `number`, so a field declared `number`
 * covers `integer` too. Without that relation `number -> integer` would look
 * like a disjoint change rather than the narrowing it is.
 */
export function expandTypes(type) {
  const tokens = Array.isArray(type) ? [...type] : [type]
  const set = new Set(tokens)
  if (set.has('number')) set.add('integer')
  return Object.freeze([...set].sort(byCodeUnit))
}

function docsOf(node) {
  const docs = {}
  for (const keyword of DOC_KEYWORDS) {
    if (Object.hasOwn(node, keyword)) docs[keyword] = JSON.stringify(node[keyword]) ?? 'undefined'
  }
  return docs
}

function sameDocs(left, right) {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(byCodeUnit)
  return keys.every((key) => left[key] === right[key])
}

/**
 * Validate one schema node and everything under it.
 *
 * Returns the problems found plus the counters the caller needs to decide
 * whether a limit was reached. A node that fails validation is never compared:
 * a comparison of two schemas the tool could not read would be a guess reported
 * as a verdict.
 */
export function validateSchema(node, pointer, limits) {
  const problems = []
  const counters = { fields: 0, depthExceeded: false, fieldsExceeded: false }
  visitForValidation(node, pointer, 1, problems, counters, limits)
  return { problems, counters }
}

function visitForValidation(node, pointer, depth, problems, counters, limits) {
  if (depth > limits.maxSchemaDepth) {
    if (!counters.depthExceeded) {
      counters.depthExceeded = true
      problems.push({
        ruleId: 'schema-too-deep',
        pointer,
        message: `Schema nesting is deeper than the maxSchemaDepth limit of ${limits.maxSchemaDepth}, so the rest of this schema was not read.`,
      })
    }
    return
  }
  if (!isRecord(node)) {
    problems.push({ ruleId: 'schema-invalid', pointer, message: 'A schema node must be a JSON object.' })
    return
  }

  for (const key of Object.keys(node).sort(byCodeUnit)) {
    if (!SCHEMA_KEYWORDS.includes(key)) {
      problems.push({
        ruleId: 'schema-unknown-keyword',
        pointer: `${pointer}/${escapePointerSegment(key)}`,
        message: `Unknown schema keyword "${sanitize(key, 60)}". Most validators ignore a keyword they do not know, which is how a misspelled "required" silently drops a requirement.`,
        evidence: key,
      })
    }
  }

  if (node.type === undefined) {
    problems.push({ ruleId: 'schema-invalid', pointer, message: 'A schema node must declare a type.' })
    return
  }
  const tokens = Array.isArray(node.type) ? node.type : [node.type]
  if (tokens.length === 0) {
    problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/type`, message: 'A type array must not be empty.' })
    return
  }
  for (const token of tokens) {
    if (typeof token !== 'string' || !JSON_TYPES.includes(token)) {
      problems.push({
        ruleId: 'schema-invalid',
        pointer: `${pointer}/type`,
        message: `Unsupported type "${sanitize(String(token), 40)}"; use one of ${JSON_TYPES.join(', ')}.`,
        evidence: String(token),
      })
      return
    }
  }
  if (new Set(tokens).size !== tokens.length) {
    problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/type`, message: 'A type array must not repeat a type.' })
  }

  const types = new Set(tokens)

  if (node.additionalProperties !== undefined) {
    if (typeof node.additionalProperties !== 'boolean') {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/additionalProperties`, message: 'additionalProperties must be a boolean.' })
    } else if (!types.has('object')) {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/additionalProperties`, message: 'additionalProperties applies only to a node whose type includes object.' })
    }
  }

  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/required`, message: 'required must be an array of property names.' })
    } else if (!types.has('object')) {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/required`, message: 'required applies only to a node whose type includes object.' })
    } else if (new Set(node.required).size !== node.required.length) {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/required`, message: 'required must not name the same property twice.' })
    }
  }

  if (node.properties !== undefined) {
    if (!isRecord(node.properties)) {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/properties`, message: 'properties must be a JSON object.' })
    } else if (!types.has('object')) {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/properties`, message: 'properties applies only to a node whose type includes object.' })
    } else {
      const declared = new Set(Object.keys(node.properties))
      if (Array.isArray(node.required)) {
        for (const name of node.required) {
          if (typeof name === 'string' && !declared.has(name)) {
            problems.push({
              ruleId: 'schema-invalid',
              pointer: `${pointer}/required`,
              message: `required names "${sanitize(name, 60)}", which is not declared in properties.`,
            })
          }
        }
      }
      for (const name of Object.keys(node.properties).sort(byCodeUnit)) {
        counters.fields += 1
        if (counters.fields > limits.maxFields) {
          if (!counters.fieldsExceeded) {
            counters.fieldsExceeded = true
            problems.push({
              ruleId: 'too-many-fields',
              pointer,
              message: `This schema declares more fields than the maxFields limit of ${limits.maxFields}, so the rest of it was not read.`,
            })
          }
          return
        }
        visitForValidation(node.properties[name], `${pointer}/properties/${escapePointerSegment(name)}`, depth + 1, problems, counters, limits)
      }
    }
  } else if (Array.isArray(node.required) && node.required.length > 0 && types.has('object')) {
    for (const name of node.required) {
      problems.push({
        ruleId: 'schema-invalid',
        pointer: `${pointer}/required`,
        message: `required names "${sanitize(String(name), 60)}", but this node declares no properties.`,
      })
    }
  }

  if (node.items !== undefined) {
    if (!types.has('array')) {
      problems.push({ ruleId: 'schema-invalid', pointer: `${pointer}/items`, message: 'items applies only to a node whose type includes array.' })
    } else {
      visitForValidation(node.items, `${pointer}/items`, depth + 1, problems, counters, limits)
    }
  }
}

/**
 * Flatten a validated schema into `path -> descriptor`.
 *
 * The path is a JSON Pointer fragment relative to the schema root, so the same
 * field in two versions has the same key and the comparison below is a set
 * operation rather than a tree walk that has to guess at correspondence.
 */
export function collectFields(node) {
  const fields = new Map()
  visitForCollection(node, '', true, fields)
  return fields
}

function visitForCollection(node, path, required, fields) {
  const types = expandTypes(node.type)
  fields.set(path, {
    path,
    types,
    required,
    additionalProperties: types.includes('object') ? node.additionalProperties !== false : null,
    docs: docsOf(node),
  })
  if (isRecord(node.properties)) {
    // Deliberately not sorted here. Ordering is established in exactly one
    // place -- the path sort in `compareSchemas` below -- and a second sort
    // that cannot change any output is a guarantee no test can defend and no
    // reader can trust.
    const requiredNames = new Set(Array.isArray(node.required) ? node.required : [])
    for (const name of Object.keys(node.properties)) {
      visitForCollection(node.properties[name], `${path}/properties/${escapePointerSegment(name)}`, requiredNames.has(name), fields)
    }
  }
  if (node.items !== undefined) {
    // An array item is always present when the array is: there is no "optional
    // item", so item-level required/optional transitions cannot arise.
    visitForCollection(node.items, `${path}/items`, true, fields)
  }
}

/**
 * Compare two flattened schemas and describe every change between them.
 *
 * This is the one place the order of a comparison is decided: the union of both
 * field maps is sorted by code unit, so nothing downstream depends on the order
 * either schema happened to declare its properties in. A field that disappears
 * takes its
 * subtree with it, and reporting one removal per descendant would bury the one
 * line a reviewer needs, so descendants of a removed or added path are folded
 * into the parent's finding.
 */
export function compareSchemas(before, after) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(byCodeUnit)
  const changes = []
  const folded = []

  const isFolded = (path) => folded.some((prefix) => path.startsWith(`${prefix}/`))

  for (const path of paths) {
    if (isFolded(path)) continue
    const old = before.get(path)
    const fresh = after.get(path)

    if (old !== undefined && fresh === undefined) {
      folded.push(path)
      changes.push({
        kind: old.required ? 'required-field-removed' : 'optional-field-removed',
        path,
        detail: `was removed; the earlier version declared it ${old.types.join('|')}`,
        evidence: old.types.join('|'),
      })
      continue
    }
    if (old === undefined && fresh !== undefined) {
      folded.push(path)
      changes.push({
        kind: fresh.required ? 'required-field-added' : 'optional-field-added',
        path,
        detail: `was added; the later version declares it ${fresh.types.join('|')}`,
        evidence: fresh.types.join('|'),
      })
      continue
    }

    if (old.required && !fresh.required) {
      changes.push({ kind: 'required-field-made-optional', path, detail: 'stopped being required', evidence: 'required -> optional' })
    }
    if (!old.required && fresh.required) {
      changes.push({ kind: 'optional-field-made-required', path, detail: 'became required', evidence: 'optional -> required' })
    }

    const lost = old.types.filter((type) => !fresh.types.includes(type))
    const gained = fresh.types.filter((type) => !old.types.includes(type))
    const transition = `${old.types.join('|')} -> ${fresh.types.join('|')}`
    if (lost.length > 0) {
      changes.push({ kind: 'field-type-narrowed', path, detail: `narrowed from ${old.types.join('|')} to ${fresh.types.join('|')}, dropping ${lost.join('|')}`, evidence: transition })
    }
    if (gained.length > 0) {
      changes.push({ kind: 'field-type-widened', path, detail: `widened from ${old.types.join('|')} to ${fresh.types.join('|')}, adding ${gained.join('|')}`, evidence: transition })
    }

    if (old.additionalProperties === true && fresh.additionalProperties === false) {
      changes.push({ kind: 'additional-properties-restricted', path, detail: 'stopped allowing additional properties', evidence: 'additionalProperties true -> false' })
    }
    if (old.additionalProperties === false && fresh.additionalProperties === true) {
      changes.push({ kind: 'additional-properties-relaxed', path, detail: 'started allowing additional properties', evidence: 'additionalProperties false -> true' })
    }

    if (!sameDocs(old.docs, fresh.docs)) {
      changes.push({ kind: 'documentation-changed', path, detail: 'changed only in documentation keywords', evidence: DOC_KEYWORDS.join(', ') })
    }
  }

  return changes
}

/** A readable name for a field path, for the message text. */
export function describePath(path) {
  if (path === '') return 'the payload root'
  const segments = path.split('/').filter((segment) => segment !== '')
  const names = []
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === 'properties') {
      names.push(segments[index + 1] ?? '?')
      index += 1
    } else if (segments[index] === 'items') names.push('[]')
  }
  return names.length === 0 ? 'the payload root' : sanitize(names.join('.'), 120)
}
