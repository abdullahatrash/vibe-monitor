# Mistral brand — design tokens

Light mode, Mistral orange accents, sharp edges. All UI color/radius flows
through the token layer in `src/renderer/src/styles.css` (`:root`). Components
reference tokens only — no raw hex/rgba and no non-zero radius in component rules.

## The rule

- **Orange = fills, borders, gradients.** Use `--accent` / `--accent-grad`.
- **Orange text = `--accent-text`** (a darker burnt orange). The vivid fill
  orange (`--accent`) fails WCAG AA as text on the light background, so any
  orange _text_ must use `--accent-text`.
- **Body text = `--text`** (warm near-black). Secondary text = `--muted`.
- **Radius = `--radius` (0).** Every corner is square — cards, buttons, inputs,
  chips, badges, alerts, and the status dot.

## Palette

| Token                   | Value                                          | Use                                  |
| ----------------------- | ---------------------------------------------- | ------------------------------------ |
| `--bg`                  | `#fafaf8`                                       | App background (warm off-white)      |
| `--surface`             | `#ffffff`                                       | Surface alias                        |
| `--panel`               | `#ffffff`                                       | Cards / raised surfaces              |
| `--border`              | `#e7e3dd`                                       | Borders / dividers (warm light gray) |
| `--text`                | `#1e1a17`                                       | Body text (warm near-black)          |
| `--muted`               | `#6b6a66`                                       | Secondary / muted text               |
| `--accent`              | `#fa500f`                                       | Orange fills, borders, dot           |
| `--accent-text`         | `#c2410c`                                       | Orange **text** (AA-safe)            |
| `--accent-grad`         | `linear-gradient(135deg, #ff8a00, #f23005)`     | Primary buttons / active states      |
| `--on-accent`           | `#1a1100`                                       | Label color on the orange gradient   |
| `--ok`                  | `#1a7f37`                                       | Success text / status                |
| `--bad`                 | `#b42318`                                       | Error text / status                  |
| `--radius`              | `0`                                             | All corners                          |

### Semantic tints (token-layer rgba; never raw rgba in component rules)

| Token                  | Value                       | Use                          |
| ---------------------- | --------------------------- | ---------------------------- |
| `--accent-tint`        | `rgba(250, 80, 15, 0.08)`   | Sign-in / permission bg      |
| `--accent-tint-border` | `rgba(250, 80, 15, 0.35)`   | Sign-in / permission border  |
| `--ok-tint`            | `rgba(26, 127, 55, 0.10)`   | Badge / signed-in bg         |
| `--ok-tint-border`     | `rgba(26, 127, 55, 0.35)`   | Badge border                 |
| `--bad-tint`           | `rgba(180, 35, 24, 0.08)`   | Alert bg                     |
| `--bad-tint-border`    | `rgba(180, 35, 24, 0.35)`   | Alert border                 |

## Contrast (WCAG, computed on `--bg` `#fafaf8` unless noted)

| Pair                                       | Ratio   | AA (normal ≥4.5) |
| ------------------------------------------ | ------- | ---------------- |
| `--text` `#1e1a17`                         | 16.53:1 | pass             |
| `--muted` `#6b6a66`                        | 5.18:1  | pass             |
| `--accent-text` `#c2410c`                  | 4.96:1  | pass             |
| `--ok` `#1a7f37`                           | 4.86:1  | pass             |
| `--bad` `#b42318`                          | 6.29:1  | pass             |
| `--accent` `#fa500f` (fill only, not text) | 3.23:1  | n/a — fills only |
| `--on-accent` `#1a1100` on gradient        | 7.91 → 4.63:1 | pass (whole gradient range) |

The button label (`--on-accent`, dark) is verified across the full gradient:
7.91:1 at the amber stop (`#ff8a00`) down to 4.63:1 at the red-orange stop
(`#f23005`) — AA across the entire fill.
