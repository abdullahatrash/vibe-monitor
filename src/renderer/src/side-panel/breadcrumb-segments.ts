/**
 * Pure view-model helpers for the file-preview breadcrumb + tab label (#189, ADR-0013 decision 2).
 * A `file:` Surface's breadcrumb is a read-only, non-interactive trail of its relative path; the
 * tab shows the basename. Kept DOM-free so the load-bearing splitting/truncation is unit-tested
 * and the `FilePreview` JSX stays a thin map over these.
 */

/** One breadcrumb crumb: a path segment `label`, or an `ellipsis` placeholder for elided middles. */
export interface BreadcrumbSegment {
  label: string
  /** True for the single "…" crumb inserted when a deep path is truncated (no label then). */
  ellipsis?: boolean
}

/** The file name (last segment) of a relative path — the tab label. Empty string for empty input. */
export function fileBasename(relativePath: string): string {
  const parts = relativePath.split('/').filter((s) => s.length > 0)
  return parts.at(-1) ?? ''
}

/**
 * Split a forward-slash relative path into breadcrumb crumbs, truncating a DEEP path gracefully:
 * when it has more than `maxSegments` segments, keep the FIRST segment (orientation) + a single
 * "…" ellipsis crumb + the LAST `maxSegments - 2` segments (the file and its nearest parents, the
 * most specific context). A path within the budget returns all its segments as labels. Empty
 * segments (leading/duplicate slashes) are dropped; empty input yields `[]`.
 */
export function breadcrumbSegments(relativePath: string, maxSegments = 4): BreadcrumbSegment[] {
  const parts = relativePath.split('/').filter((s) => s.length > 0)
  if (parts.length <= maxSegments) return parts.map((label) => ({ label }))
  const tailCount = Math.max(1, maxSegments - 2)
  const head: BreadcrumbSegment = { label: parts[0] }
  const tail = parts.slice(parts.length - tailCount).map((label) => ({ label }))
  return [head, { label: '…', ellipsis: true }, ...tail]
}
