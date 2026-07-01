import type { PermissionOption } from './reducer'

/**
 * Classify a permission option as reject/deny vs. allow/approve (#116). Vibe's ACP
 * `request_permission` options carry a `kind` — the deny actions are the ones whose
 * kind starts with `reject` (`reject_once`, `reject_always`); everything else
 * (`allow_once`, `allow_always`, …) is an allow action. Drives BOTH the button styling
 * (allow = primary, reject = outline) and `recover()`'s auto-deny of a wedged turn, so
 * the two stay in lockstep. Pure/DOM-free — takes just the `kind` it reads.
 */
export function isRejectOption(option: Pick<PermissionOption, 'kind'>): boolean {
  return option.kind.startsWith('reject')
}
