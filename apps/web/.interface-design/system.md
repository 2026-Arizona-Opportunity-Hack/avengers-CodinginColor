# Cadence interface system

Decisions for the Cadence web app. Hold to these when adding screens. Values live in `src/styles.css`.

## Direction

- **Who:** Coding in Color's Founder/CEO (whole-org health, funder packets) and board members (their own donors, a text or call logged in seconds).
- **Feel:** calm and light: a working ledger on frosted glass, not a marketing page.
- **Signature:** approve-before-send is always visible as a three-step trail (drafted → approved by a person → sent by a person).

## Color

- One accent: CIC green `#007A3D` (`--primary`), used only for the primary action, the active state and positive trends.
- Amber `--attention` means due soon. Red `--danger` means overdue or destructive. Both always appear with an icon or words.
- Charts use green and blue `#2A78D6` for this year against last year. These colors were checked with the dataviz `validate_palette` script.
- Text uses ink `#0F1A15` for primary text and `#3C4A43` for secondary text. Avoid light gray text.

## Type

- Instrument Sans throughout. Numbers use `tabular-nums`.
- Scale: page `24` · section `15` · body `14` · meta `12.5`. Hierarchy comes from weight and color before size.
- Every page has one `h1` and a one-line description. Panel headers have a title and an optional action link, never a subtitle.

## Depth, radius, spacing

- **Depth:** one strategy, the layered ring shadow `--glass-shadow`. No borders on cards. Hairlines are allowed only as dividers inside a surface.
- **Radius:** controls `10` · items `12` · surfaces `16` · overlays `20`.
- **Spacing:** 4px base. Surfaces are padded `20`; the gap between surfaces is `20`.
- **Sidebar:** shares the canvas, with only a hairline border. Blur is used only on the sticky top bar.
- **Inputs:** inset, using `--control-bg`, and turn white on focus.

## Components

- Buttons: spartan `hlmBtn` (or `.btn`) is `36px` tall with a `10px` radius. Primary is green; outline is white with a ring. Press feedback is `scale(0.97)`.
- Lists of work (Outreach, Funders, Settings) use a queue or navigation on the left and one detail pane on the right.
- Overview has one focal figure (net raised). Secondary metrics sit in a lower tier on the same surface.

## Motion

- Page change: a 160ms fade. Controls use `cubic-bezier(0.23, 1, 0.32, 1)` and finish in under 300ms. Charts animate in 350ms.
- No count-up figures and no moving backdrop. All motion turns off under `prefers-reduced-motion`.

## Checks before shipping

- `npx ng build` and `npx ng test --watch=false` pass.
- axe-core (WCAG 2.1 A/AA) reports 0 violations on every route, both as an admin and as a board member.
- Screenshots reviewed at 1440px and 390px wide.
