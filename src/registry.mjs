/**
 * Reading a registry directory.
 *
 * This module does every unsafe thing the tool does: it walks a directory it
 * did not create, follows links it did not plant, and decodes bytes it did not
 * write. Three properties are structural rather than incidental:
 *
 * 1. **Containment is checked on real paths, both sides.** Refusing `../` is
 *    not confinement -- a symlink inside the root resolves out of the tree
 *    without ever spelling a traversal. Comparing a real candidate against an
 *    unresolved root is the same defect in the other direction: it refuses
 *    files that genuinely are inside a root reached through a symlink, and a
 *    false refusal is a bug too.
 * 2. **Decoding is strict.** Undecodable bytes are missing evidence, never a
 *    document with replacement characters in it.
 * 3. **Every limit is explicit and named when it is reached.** Nothing is
 *    silently truncated and nothing that was not read is reported as read.
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { byCodeUnit, decodeUtf8, parseFailureDetail, sanitize } from './text.mjs'

/** Directories never walked. A dependency tree is not an event registry. */
export const SKIPPED_DIRECTORIES = Object.freeze(['.git', 'node_modules'])

export const REGISTRY_ROOT = '.'

/** Is `candidate` the real root, or genuinely inside it? Both are real paths. */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function relativeFile(root, absolute) {
  const value = relative(root, absolute)
  return sanitize(value === '' ? REGISTRY_ROOT : value.split(sep).join('/'), 200)
}

/**
 * Walk `realRoot` and return the parsed event documents, in code-unit order by
 * relative path, plus the problems met on the way.
 *
 * `clock` returns elapsed milliseconds and is injected so that the time budget
 * is testable and so that no wall-clock reading ever reaches output.
 */
export async function readRegistry({ realRoot, limits, clock }) {
  const problems = []
  const documents = []
  const state = { stopped: false, candidates: 0, visitedDirectories: new Set(), deadline: clock() + limits.timeoutMs }

  const push = (ruleId, file, message, extra = {}) => problems.push({ ruleId, file, message, ...extra })

  const outOfTime = () => {
    if (state.stopped) return true
    // `<` rather than `<=`, so a budget of 0 ms leaves no time at all and the
    // flag can be proven wired from outside the process.
    if (clock() < state.deadline) return false
    state.stopped = true
    push(
      'time-budget-exceeded',
      REGISTRY_ROOT,
      `Reading the registry passed the timeoutMs budget of ${limits.timeoutMs}, so part of it was not read.`,
    )
    return true
  }

  async function walk(absolute, depth) {
    if (depth > limits.maxDepth) {
      push(
        'directory-too-deep',
        relativeFile(realRoot, absolute),
        `This directory is deeper than the maxDepth limit of ${limits.maxDepth}, so it was not read.`,
      )
      return
    }

    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      push('event-unreadable', relativeFile(realRoot, absolute), `This directory could not be listed: ${sanitize(error.code ?? 'unknown error', 40)}.`)
      return
    }

    const names = entries.map((entry) => entry.name).sort(byCodeUnit)
    for (const name of names) {
      if (state.stopped) return
      const child = join(absolute, name)
      let info
      try {
        info = await stat(child)
      } catch (error) {
        push('event-unreadable', relativeFile(realRoot, child), `This entry could not be inspected: ${sanitize(error.code ?? 'unknown error', 40)}.`)
        continue
      }

      if (info.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(name)) continue
        let realChild
        try {
          realChild = await realpath(child)
        } catch (error) {
          push('event-unreadable', relativeFile(realRoot, child), `This directory could not be resolved: ${sanitize(error.code ?? 'unknown error', 40)}.`)
          continue
        }
        if (!isInside(realRoot, realChild)) {
          push('path-escapes-root', relativeFile(realRoot, child), 'This directory resolves outside the registry root and was not read.')
          continue
        }
        // Directories are de-duplicated by real path so a symlink loop cannot
        // make the walk run forever. Files deliberately are not: a regular file
        // reachable under two names inside the root is two declarations, and
        // dropping one of them would silently lose an event.
        if (state.visitedDirectories.has(realChild)) continue
        state.visitedDirectories.add(realChild)
        await walk(child, depth + 1)
        if (outOfTime()) return
        continue
      }

      if (!info.isFile() || !name.endsWith('.json')) continue
      state.candidates += 1
      await readEventFile(child, info)
      // The budget is checked after an entry rather than before it, so a walk
      // always attempts at least one entry and a budget of 0 ms stops after the
      // first. Guarding the size of any single entry is maxFileBytes' job, not
      // the clock's.
      if (outOfTime()) return
    }
  }

  async function readEventFile(absolute, info) {
    const file = relativeFile(realRoot, absolute)

    let realFile
    try {
      realFile = await realpath(absolute)
    } catch (error) {
      push('event-unreadable', file, `This file could not be resolved: ${sanitize(error.code ?? 'unknown error', 40)}.`)
      return
    }
    if (!isInside(realRoot, realFile)) {
      push('path-escapes-root', file, 'This file resolves outside the registry root and was not read.')
      return
    }

    if (documents.length >= limits.maxEvents) {
      if (!state.stopped) {
        state.stopped = true
        push('too-many-events', REGISTRY_ROOT, `The registry holds more event files than the maxEvents limit of ${limits.maxEvents}, so the rest were not read.`)
      }
      return
    }

    if (info.size > limits.maxFileBytes) {
      push('event-too-large', file, `This file is ${info.size} bytes, over the maxFileBytes limit of ${limits.maxFileBytes}, so it was not read.`)
      return
    }

    let bytes
    try {
      bytes = await readFile(realFile)
    } catch (error) {
      push('event-unreadable', file, `This file could not be read: ${sanitize(error.code ?? 'unknown error', 40)}.`)
      return
    }

    const decoded = decodeUtf8(bytes)
    if (!decoded.ok) {
      push('event-not-utf8', file, 'This file is not valid UTF-8, so it was not parsed.')
      return
    }

    let document
    try {
      document = JSON.parse(decoded.text)
    } catch (error) {
      push('event-not-json', file, `This file is not valid JSON: ${sanitize(parseFailureDetail(error), 120)}`)
      return
    }

    documents.push({ file, document })
  }

  await walk(realRoot, 0)
  documents.sort((left, right) => byCodeUnit(left.file, right.file))
  problems.sort((left, right) => byCodeUnit(left.file, right.file) || byCodeUnit(left.ruleId, right.ruleId))
  return { documents, problems, candidates: state.candidates }
}
