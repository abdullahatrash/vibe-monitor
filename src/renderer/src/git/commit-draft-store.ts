/**
 * Ephemeral per-Workspace commit drafts (#187 review fold). Collapsing the Review Surface
 * now UNMOUNTS ChangesPanel, whereas its old internal collapse only hid the body — so a
 * half-typed commit message (and the #86 deselection set) used to survive collapse/expand
 * and would now be discarded, one accidental ⌃⇧G away. This module-level store restores
 * that parity across the remount (the follow-up-queue idiom: module state outlives the
 * component). Renderer-session only — deliberately NOT localStorage: the old behavior
 * never survived a restart either, and a stale commit message is worse than none.
 */
export interface CommitDraft {
  message: string
  unchecked: ReadonlySet<string>
}

const drafts = new Map<string, CommitDraft>()

export function getCommitDraft(workspaceDir: string): CommitDraft | undefined {
  return drafts.get(workspaceDir)
}

/**
 * Store the live draft. An EMPTY draft (no message, nothing deselected) deletes the entry
 * instead, so the map only holds Workspaces with something worth restoring — and a
 * successful commit (which clears the message) leaves no residue.
 */
export function setCommitDraft(workspaceDir: string, draft: CommitDraft): void {
  if (draft.message === '' && draft.unchecked.size === 0) drafts.delete(workspaceDir)
  else drafts.set(workspaceDir, draft)
}

/** Test seam — the map is module-global. */
export function clearCommitDrafts(): void {
  drafts.clear()
}
