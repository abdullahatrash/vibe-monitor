/**
 * File-path chip links (#114) — the pure, DOM-free parse behind the orange file
 * chip in rendered agent markdown. A markdown link destination (`[text](href)`)
 * is classified as a file path (→ chip) or not (→ plain link), any trailing
 * `:line:col` position or `#Lx[Cy]` anchor is split off, and colliding basenames
 * across one message are disambiguated with parent directories.
 *
 * Ported and trimmed from t3code's `markdown-links.ts` — the `localApi`/editor-open
 * plumbing and workspace-relative display are dropped (the chip is a thin consumer
 * that only needs a label + line ref). Kept DOM-free; the sole import is the shared
 * `basename` helper.
 */
import { basename } from '../lib/paths'

/** A markdown link destination recognised as a file path. */
export interface FileLink {
  /** The file path with any `:line:col` / `#Lx` position stripped off. */
  path: string
  /** The file's basename (e.g. `reducer.ts`) — the chip label before disambiguation. */
  basename: string
  /** 1-based line, when the destination carried one. */
  line?: number
  /** 1-based column, when the destination carried one. */
  column?: number
}

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/
const POSIX_FILE_ROOT_PREFIXES = [
  '/Users/',
  '/home/',
  '/tmp/',
  '/var/',
  '/etc/',
  '/opt/',
  '/mnt/',
  '/Volumes/',
  '/private/',
  '/root/',
] as const

/** Every markdown link destination `(...)`, in source order. Case-insensitive
 *  fine — this is a lexical scan, not a parser. Titles after the URL are dropped. */
const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function unwrapAngleBrackets(value: string): string {
  return value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value
}

function normalizeDestination(value: string): string {
  return unwrapAngleBrackets(value.trim())
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf('#')
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : ''
  const queryIndex = pathWithSearch.indexOf('?')
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch
  return { path, hash: rawHash }
}

/** Browsers encode `C:/foo` as `/C:/foo` for file URLs — undo that. */
function normalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path
}

function parseFileUrl(href: string): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href)
    if (parsed.protocol.toLowerCase() !== 'file:') return null
    if (parsed.pathname.length === 0) return null
    return { path: normalizeWindowsDrivePath(safeDecode(parsed.pathname)), hash: parsed.hash }
  } catch {
    return null
  }
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith('/')) return false
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  if (POSITION_SUFFIX_PATTERN.test(path)) return true
  const basename = path.slice(path.lastIndexOf('/') + 1)
  return /\.[A-Za-z0-9_-]+$/.test(basename)
}

/** Map a trailing `#L42` / `#L42C7` anchor onto a `:line:col` suffix. */
function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i)
  if (!match?.[1]) return path
  return `${path}:${match[1]}${match[2] ? `:${match[2]}` : ''}`
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true
  if (path.startsWith('/')) return looksLikePosixFilesystemPath(path)
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path)
}

/** A real URL scheme (`https:`, `mailto:`) — but NOT a bare `file.ts:10` line ref,
 *  whose "scheme" tail is a pure position. */
function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN)
  if (!match) return false
  const rest = match[2] ?? ''
  if (rest.startsWith('//')) return true
  return !POSITION_ONLY_PATTERN.test(rest)
}

/** Split a `path:line[:col]` string into its parts (position optional). */
function splitPathAndPosition(value: string): {
  path: string
  line?: number
  column?: number
} {
  const columnMatch = value.match(/:(\d+)$/)
  if (!columnMatch?.[1]) return { path: value }

  let path = value.slice(0, -columnMatch[0].length)
  const first = Number.parseInt(columnMatch[1], 10)

  const lineMatch = path.match(/:(\d+)$/)
  if (lineMatch?.[1]) {
    path = path.slice(0, -lineMatch[0].length)
    return { path, line: Number.parseInt(lineMatch[1], 10), column: first }
  }
  return { path, line: first }
}

/**
 * Classify one markdown link destination. Returns a `FileLink` when it looks like
 * a file path (absolute, relative, `file://`, with an optional line/col position),
 * or `null` for external URLs, bare `#anchors`, and app routes.
 */
export function parseFileLink(href: string | undefined): FileLink | null {
  if (!href) return null
  const raw = normalizeDestination(href)
  if (raw.length === 0 || raw.startsWith('#')) return null

  const fileUrl = raw.toLowerCase().startsWith('file:') ? parseFileUrl(raw) : null
  const source = fileUrl ?? stripSearchAndHash(raw)
  const decodedPath = normalizeWindowsDrivePath(
    fileUrl ? source.path.trim() : safeDecode(source.path.trim()),
  )
  const decodedHash = safeDecode(source.hash.trim())

  if (decodedPath.length === 0) return null
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null
  }
  if (!isLikelyPathCandidate(decodedPath)) return null

  const withPosition = appendLineColumnFromHash(decodedPath, decodedHash)
  const { path, line, column } = splitPathAndPosition(withPosition)
  return {
    path,
    basename: basename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  }
}

/** Schemes we allow a rendered markdown link (`<a href>`) to carry. Everything else
 *  — notably `javascript:`/`data:`/`vbscript:` — is rejected so the anchor can't
 *  become a script sink. A scheme-less href (relative path, `#anchor`, `mailto`-less)
 *  is safe: it can't execute. */
const SAFE_EXTERNAL_HREF_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

/**
 * True when a markdown link destination is safe to render as a real `<a href>`:
 * either it carries no URL scheme (relative/anchor — inert) or its scheme is in the
 * allow-list. Pure/DOM-free defence-in-depth for the Response `a` override — streamdown's
 * harden chain already blocks dangerous hrefs upstream; this keeps the override safe on
 * its own regardless of that chain.
 */
export function isSafeExternalHref(href: string | undefined): boolean {
  if (!href) return false
  const value = normalizeDestination(href)
  if (value.length === 0) return false
  const match = value.match(EXTERNAL_SCHEME_PATTERN)
  if (!match) return true // no scheme → relative/anchor, cannot execute
  return SAFE_EXTERNAL_HREF_SCHEMES.has((match[1] ?? '').toLowerCase())
}

/** Every markdown link destination in a block of text, in source order. */
export function extractLinkHrefs(text: string): string[] {
  const hrefs: string[] = []
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    if (match[1]) hrefs.push(match[1])
  }
  return hrefs
}

function parentSegments(path: string): string[] {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .slice(0, -1)
}

/**
 * Given the file paths appearing in one message, return a display label per path:
 * the basename alone when unique, or `basename · <nearest distinguishing parent>`
 * when two paths share a basename. Non-colliding paths are untouched. The chip
 * appends the `Lx:Cy` line ref separately — labels never include position.
 */
export function fileLinkLabels(paths: readonly string[]): Map<string, string> {
  const uniquePaths = [...new Set(paths)]
  const byBasename = new Map<string, string[]>()
  for (const path of uniquePaths) {
    const base = basename(path)
    const group = byBasename.get(base) ?? []
    group.push(path)
    byBasename.set(base, group)
  }

  const labels = new Map<string, string>()
  for (const [base, group] of byBasename) {
    if (group.length < 2) {
      const only = group[0]
      if (only) labels.set(only, base)
      continue
    }

    const segmentsByPath = new Map(group.map((path) => [path, parentSegments(path)]))
    for (const path of group) {
      const segments = segmentsByPath.get(path) ?? []
      let suffix = ''
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join('/')
        const collides = group.some(
          (other) =>
            other !== path && (segmentsByPath.get(other) ?? []).slice(-depth).join('/') === candidate,
        )
        if (!collides) {
          suffix = candidate
          break
        }
      }
      labels.set(path, suffix ? `${base} · ${suffix}` : base)
    }
  }
  return labels
}
