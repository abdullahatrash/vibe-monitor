/**
 * Tiny path helpers shared across the renderer (which has no `node:path`). One
 * `basename()` covers every place we needed "the last path segment": the file-link
 * chip labels, the file-preview breadcrumb tab, and the preview highlighter's language
 * detection.
 */

/**
 * The last segment of a path — its file name. Handles BOTH forward and backslash
 * separators (agent-authored links can carry either), and tolerates trailing /
 * duplicate separators by dropping empty segments. Empty input → `''`.
 */
export function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0)
  return segments.at(-1) ?? ''
}
