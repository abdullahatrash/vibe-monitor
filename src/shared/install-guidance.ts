/**
 * Canonical missing-CLI copy, shared by every surface that tells the user to
 * install Mistral Vibe: main's spawn-failure hint, the first-run screen, the
 * Environment panel, and the persistent shell banner. One root cause, one
 * message — these surfaces must not drift apart again. Must stay free of
 * Node/DOM imports (imported from both main and renderer).
 */

export const INSTALL_DOCS_URL = 'https://docs.mistral.ai/vibe/code/cli/install-setup'

/** The one actionable install hint. Backtick spans render as inline code in the UI. */
export const INSTALL_HINT =
  'Install the Mistral Vibe CLI and ensure `vibe-acp` is on your PATH, then run `vibe` to sign in.'
