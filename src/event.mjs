/**
 * Validation of one event declaration document.
 *
 * Everything here is a property of a single file: the event's name, its owner,
 * its version sequence and the shape of each payload schema. Compatibility
 * between versions is decided in `src/index.mjs`, because it depends on the run
 * mode; a document that fails validation here is never compared, since a
 * comparison of schemas the tool could not read would be a guess reported as a
 * verdict.
 */

import { MODES, validateSchema } from './compare.mjs'
import { byCodeUnit, sanitize } from './text.mjs'

/**
 * The keys an event document may carry.
 *
 * An unknown key is refused rather than ignored. `consumer` instead of
 * `consumers` would otherwise silently empty the list this tool names breakage
 * candidates from, and a one-character typo that turns a real failure into a
 * quieter run is the defect this catalog keeps finding.
 */
export const EVENT_KEYS = Object.freeze(
  ['compatibility', 'consumers', 'description', 'name', 'owner', 'producers', 'versions'].sort(byCodeUnit),
)

/** The keys one entry of `versions` may carry. Same reasoning. */
export const VERSION_KEYS = Object.freeze(['description', 'schema', 'version'].sort(byCodeUnit))

/**
 * Event names are `domain.event_name`: lower-case segments separated by dots,
 * words inside a segment separated by single underscores, at least one dot so
 * that the owning domain is always visible in a topic listing.
 */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/
export const EVENT_NAME_MAX_LENGTH = 120

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
}

function serviceList(value) {
  return Object.freeze([...new Set(value.map((entry) => sanitize(entry, 80)))].sort(byCodeUnit))
}

/**
 * Validate one parsed event document.
 *
 * Returns `{ event, problems }`. `event` is `null` when the document is too
 * broken to compare; `problems` carry a rule id and a JSON Pointer into the
 * document and are turned into findings by the caller, which owns the severity
 * table.
 */
export function validateEventDocument(document, limits) {
  const problems = []
  const push = (ruleId, pointer, message, evidence) => problems.push({ ruleId, pointer, message, evidence })

  if (!isRecord(document)) {
    push('event-malformed', '', 'An event declaration must be a JSON object.')
    return { event: null, problems }
  }

  for (const key of Object.keys(document).sort(byCodeUnit)) {
    if (!EVENT_KEYS.includes(key)) {
      push('event-unknown-key', `/${sanitize(key, 60)}`, `Unknown key "${sanitize(key, 60)}"; an event declares ${EVENT_KEYS.join(', ')}.`, key)
    }
  }

  let name = null
  if (typeof document.name !== 'string' || document.name === '') {
    push('event-name-invalid', '/name', 'An event must declare a name.')
  } else if (document.name.length > EVENT_NAME_MAX_LENGTH) {
    push('event-name-invalid', '/name', `An event name must be at most ${EVENT_NAME_MAX_LENGTH} characters long.`)
  } else if (!EVENT_NAME_PATTERN.test(document.name)) {
    push('event-name-invalid', '/name', `"${sanitize(document.name, 80)}" is not a valid event name; use lower-case domain.event_name, for example orders.order_placed.`, document.name)
  } else {
    name = document.name
  }

  let owner = null
  if (typeof document.owner !== 'string' || document.owner.trim() === '') {
    push('owner-missing', '/owner', 'Every event needs an owner: the team or rota answerable for this contract.')
  } else {
    owner = sanitize(document.owner, 80)
  }

  let compatibility = null
  if (document.compatibility !== undefined) {
    if (typeof document.compatibility !== 'string' || !MODES.includes(document.compatibility)) {
      push('event-malformed', '/compatibility', `compatibility must be one of ${MODES.join(', ')}.`)
    } else {
      compatibility = document.compatibility
    }
  }

  if (document.description !== undefined && typeof document.description !== 'string') {
    push('event-malformed', '/description', 'description must be a string.')
  }

  const sides = {}
  for (const side of ['consumers', 'producers']) {
    if (document[side] === undefined) {
      sides[side] = []
      push(`${side}-missing`, `/${side}`, `No ${side} are declared, so this registry cannot name a ${side.slice(0, -1)} breakage candidate for this event.`)
    } else if (!nonEmptyStrings(document[side])) {
      sides[side] = []
      push('event-malformed', `/${side}`, `${side} must be an array of non-empty service names.`)
    } else if (document[side].length === 0) {
      sides[side] = []
      push(`${side}-missing`, `/${side}`, `No ${side} are declared, so this registry cannot name a ${side.slice(0, -1)} breakage candidate for this event.`)
    } else {
      sides[side] = serviceList(document[side])
    }
  }

  if (!Array.isArray(document.versions) || document.versions.length === 0) {
    push('versions-missing', '/versions', 'An event must declare at least one version with a payload schema.')
    return { event: null, problems }
  }
  if (document.versions.length > limits.maxVersions) {
    push('too-many-versions', '/versions', `This event declares more versions than the maxVersions limit of ${limits.maxVersions}, so none of them were compared.`)
    return { event: null, problems }
  }

  const versions = []
  const seen = new Set()
  let sequenceBroken = false

  for (let index = 0; index < document.versions.length; index += 1) {
    const pointer = `/versions/${index}`
    const entry = document.versions[index]
    if (!isRecord(entry)) {
      push('event-malformed', pointer, 'A version entry must be a JSON object.')
      sequenceBroken = true
      continue
    }
    for (const key of Object.keys(entry).sort(byCodeUnit)) {
      if (!VERSION_KEYS.includes(key)) {
        push('event-unknown-key', `${pointer}/${sanitize(key, 60)}`, `Unknown key "${sanitize(key, 60)}" in a version entry; a version declares ${VERSION_KEYS.join(', ')}.`, key)
      }
    }
    if (!Number.isInteger(entry.version) || entry.version < 1) {
      push('version-sequence-invalid', `${pointer}/version`, 'A version must be an integer of 1 or more.')
      sequenceBroken = true
      continue
    }
    if (seen.has(entry.version)) {
      push('version-duplicate', `${pointer}/version`, `Version ${entry.version} is declared more than once.`)
      sequenceBroken = true
      continue
    }
    seen.add(entry.version)
    if (entry.version !== index + 1) {
      push('version-sequence-invalid', `${pointer}/version`, `Versions must be listed in order from 1 with no gaps; this entry is at position ${index + 1} and declares version ${entry.version}.`)
      sequenceBroken = true
      continue
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      push('event-malformed', `${pointer}/description`, 'description must be a string.')
    }

    const { problems: schemaProblems } = validateSchema(entry.schema, `${pointer}/schema`, limits)
    for (const problem of schemaProblems) push(problem.ruleId, problem.pointer, problem.message, problem.evidence)
    if (schemaProblems.length > 0) {
      sequenceBroken = true
      continue
    }
    versions.push({ version: entry.version, index, schema: entry.schema })
  }

  if (name === null || sequenceBroken || versions.length === 0) return { event: null, problems }

  return {
    event: {
      name,
      owner,
      compatibility,
      consumers: sides.consumers,
      producers: sides.producers,
      versions,
    },
    problems,
  }
}
