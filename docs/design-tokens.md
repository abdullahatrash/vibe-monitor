# Design tokens (from the final-design prototype)

The exact token values the design-system epic (ADR-0010) builds the foundation slice from, extracted from
`/Users/abdullahatrash/mistral/Vibe Mistro.html`. These populate `:root` (single source of truth) and are
bridged into Tailwind v4 via `@theme inline`. **Warm neutrals · softer gradient-forward orange · rounded.**

## Colors

### Neutrals (warm off-white ramp)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#fbfaf8` | page background |
| `--sidebar` | `#f5f3ef` | sidebar surface |
| `--surface` | `#fdfcfb` | cards (composer) |
| `--panel` | `#ffffff` | side panel / expanded view |
| `--border` | `#ecdfd3` | warm card/composer border |
| `--border-muted` | `#eae3da` / `#efe8e0` / `#eae5de` | panel/header/footer dividers |

### Text
| Token | Value | Use |
|---|---|---|
| `--text` | `#1c1c1c` | primary |
| `--text-strong` | `#20201e` / `#26231f` | headings, account name |
| `--text-body` | `#33302c` | nav labels, project names |
| `--text-secondary` | `#524d47` | thread rows |
| `--muted` | `#6b645d` / `#7a736b` | icon strokes, chip labels |
| `--placeholder` | `#a89f95` | input placeholder |
| `--faint` | `#a79f96` / `#b3aaa0` | section headers, timestamps |
| `--on-accent` | `#ffffff` | text/icon on orange |

### Accent (softer, gradient-forward — NOT the old `#fa500f`)
| Token | Value | Use |
|---|---|---|
| `--accent-text` | `#cf6a3a` | interactive text/icons (e.g. "New chat") |
| `--accent-emphasis` | `#e07a3e` | heading emphasis ("in chatjs?") |
| `--accent-grad-logo` | `linear-gradient(#f6c445 0%, #ef8a3c 50%, #e2452a 100%)` | the "M" mark (vertical) |
| `--accent-grad-action` | `linear-gradient(160deg, #ee9b5b, #df6f38)` | circular send button |
| `--accent-grad-avatar` | `linear-gradient(160deg, #ef9f5f, #e07640)` | account avatar |
| `--accent-tint` | `#f8e0cf` | the one filled tint (New-chat pill) |
| `--active-bg` | `#ece4da` | active window-control / nav bg |
| `--accent-shadow` | `rgba(200,90,30,0.3)` | send-button glow |

### Status / misc
| Token | Value | Use |
|---|---|---|
| `--tl-red` / `--tl-yellow` / `--tl-green` | `#ec6a5e` / `#f4bf4f` / `#61c554` | window traffic lights |
| `--card-shadow` | `0 1px 2px rgba(0,0,0,0.02)` | composer card |
| `--scrollbar-thumb` | `rgba(0,0,0,0.08)` | 8px webkit scrollbar |
| Terminal (deferred, for later) | bg `#1c1b1a`, fg `#d8d2ca`, green `#7fb56b`, blue `#6ba0d6`, gray `#a49c93` | powerline prompt |

> No dedicated success/danger UI tokens in the prototype beyond traffic lights + terminal green. Keep the
> existing `--ok`/`--bad` (+ tints) for functional states (errors, diff counts) — reconcile per-area.

## Radius (reverses today's `--radius: 0`)
| Token | px | Use |
|---|---|---|
| `--radius-sm` | 7 | icon buttons / window controls |
| `--radius` | 9 | list rows (project/thread), avatar |
| `--radius-md` | 10 | nav items |
| `--radius-pill` | 12 | New-chat pill |
| `--radius-card` | 20 | composer card, side panels |
| `--radius-full` | 9999 | circular send button, dots |

Bridge into `@theme` so `rounded-md`/`rounded-2xl` map to these (undo the current all-zero override).

## Typography
- **UI stack:** `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif`
- **Mono stack:** `'SF Mono', ui-monospace, 'Menlo', monospace` (code, terminal)
- No webfont loaded — system fonts.

| Role | size | weight | line-height | tracking |
|---|---|---|---|---|
| Hero H1 | 37px | 600 | — | -0.6px |
| Workspace title | 20px | 600 | — | -0.2px |
| Composer placeholder | 17px | 400 | — | — |
| Nav label / New chat | 15.5px | 400 / 600 | — | — |
| Body / project row / chip | 15px | 400 | 1.25 | — |
| Thread row / context chip | 14.5px | 400 | — | — |
| Section header ("Projects") | 13px | 500 | — | — |
| Timestamp / plan / small | 13px | 400 | — | — |
| Code / terminal body | 13px | 400 | 1.7 | — |

## Spacing scale
`2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 22 · 24 · 40 · 42 · 44` (micro 2–12; macro 14–24; hero 40–44).

## Fixed dimensions
| Element | Size |
|---|---|
| Sidebar | **338px** (flex-shrink:0) |
| Side panel (collapsed) | **460px** (`border-left`) |
| Side panel (expanded) | `flex:1` (chat hidden) |
| Composer / hero content max-width | **830px** |
| Terminal dock height | **230px** |
| Circular send button | 36×36 |
| Account avatar | 32×32 |
| Window-control buttons | 30×30 |
| Logo mark | 30 (header) · 52 (hero) · 38 (panel) |
| Root min-height | 660px |

## Component notes (for the primitive library)
- **Chips are borderless** inline `icon + label + chevron` groups (gap 6–8) — NOT bordered pills. The
  only filled pill is the peach New-chat (`--accent-tint`); the only active-bg is `--active-bg`.
- **Composer card:** `--surface` bg, `1px --border`, `--radius-card` (20), `--card-shadow`, padding
  `22px 24px 14px`, a 44px gap between the placeholder and the control row.
- **Send button:** 36px circle, `--accent-grad-action`, white arrow-up, `--accent-shadow` glow, no border.
- **Sidebar rows:** nav `padding:9px 12px` `--radius-md`; project `7px 12px` `--radius`; thread indented
  `7px 12px 7px 42px`, title truncates, right timestamp `--faint`.
- **Animation:** one keyframe — `@keyframes vmCursorBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }`
  (terminal cursor, `1.1s step-end infinite`).

## Icons (lucide)
Nav: `square-pen` (new chat) · `search` · `clock` (scheduled) · `atom` (plugins). Sidebar: `panel-left`,
`arrow-left`/`arrow-right`, `folder`, `chevron-down`. Composer: `plus`, `shield` (approval),
`maximize-2` (expand), `arrow-up` (send), `mic`, `sliders`/`shuffle` (reasoning). Context: `monitor`
(local), `git-branch` (branch). Top-right modes: `panel-right`, `terminal`, `maximize-2`. Panel/git:
`git-branch`, `git-commit-horizontal`, `file`, `x`. Message actions: `copy`, `thumbs-up`, `thumbs-down`,
`git-branch`/`repeat` (retry). Account: gradient avatar + `chevron-down`.
