import type { JSX } from 'react'
import { TriangleAlert } from 'lucide-react'
import { INSTALL_DOCS_URL } from '../../../shared/install-guidance'
import { Button } from '../ui/button'
import { CodeText } from '../ui/code-text'

/**
 * The persistent missing-CLI banner (t3code's provider-status banner, ours):
 * a full-width strip under the window chrome, shown whenever detection says
 * `vibe` / `vibe-acp` is missing and the fuller needs-install outlet isn't
 * already on screen (visibility is the pure `installBannerMessage`). Same
 * canonical copy as the first-run screen and main's spawn-failure hint.
 */
export function InstallBanner({
  message,
  loading,
  onRecheck,
}: {
  message: string
  loading: boolean
  onRecheck: () => void
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-none items-center gap-2.5 border-b border-[var(--bad-tint-border)] bg-[var(--bad-tint)] px-4 py-1.5 text-[13px] text-text"
    >
      <TriangleAlert className="size-4 flex-none text-bad" aria-hidden />
      <span className="min-w-0 flex-1">
        <CodeText text={message} />{' '}
        <a className="underline" href={INSTALL_DOCS_URL} target="_blank" rel="noreferrer">
          Install guide
        </a>
      </span>
      <Button variant="outline" size="xs" className="flex-none" onClick={onRecheck} disabled={loading}>
        {loading ? 'Checking…' : 'Re-check'}
      </Button>
    </div>
  )
}
