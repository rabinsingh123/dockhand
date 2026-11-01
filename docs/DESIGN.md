# Dockhand design system

One source of truth for every surface Dockhand draws: the WhatsApp phone cards, the HUD over the browser, the flight recorder, and the film's charts and cards. The code lives in `packages/design`, and the rendered reference sheet is `var/design/system.png` (`pnpm exec tsx assets/video/design.ts`).

The goal is that everything reads like a receipt, a changelog or a newspaper chart, never like a dashboard template. A judge should see a product, not a generated mock-up.

## Principles

Each principle comes from studying how good examples are built. It borrows their reasoning, not their look.

- **Stripe receipts and docs.** Label and value rows on hairlines, amounts in tabular figures, almost no color. The structure does the work, so a card needs no box, badge or icon to be clear.
- **Linear's changelog and update emails.** A date, a title that states what changed, one summary sentence, then the detail. The overnight card follows this order exactly.
- **Vercel's Geist.** One typeface family with a mono companion, a 4 px spacing scale, small radii and a strict gray scale. Hierarchy comes from size and weight.
- **Apple's product pages.** One claim per frame, set big and given room. Dockhand's version is left-aligned, never centered.
- **FT charts.** The title states the finding, the subtitle the unit, and a footnote the source. Gridlines are horizontal hairlines with an ink zero line. Every series is labelled where it ends, there are no legends and no markers, and a projection is dashed.

## Tokens (`packages/design/src/tokens.ts`)

TypeScript imports `TOKENS`. CSS gets the same values as custom properties from `cssVariables("ui" | "film")`.

| Token | Value | Use |
|---|---|---|
| paper | `#F6F5F1` | Page and card background |
| surface | `#FFFFFF` | Tables, the HUD panel |
| ink | `#111111` | Text, rules that carry meaning, Dockhand's data |
| gray | `#6B6B6B` | Secondary text, comparison data |
| faint | `#8F8C85` | Present but not in play (a rung not needed) |
| hair | `#E3E1DB` | Hairlines, gridlines |
| rule | `#CFCCC4` | Panel and screenshot edges |
| accent | `#FF4F00` | At most once per frame, only what Dockhand did |
| error | `#B42318` | Only a real failure |

- **Type.** Geist and Geist Mono (SIL OFL, bundled in `packages/design/fonts`, never fetched).
  - Weights: 600 for display at -2% tracking, sentence case; 400 and 500 for text. Figures are tabular.
  - Two scales with one ratio:
    - `ui` in CSS px, for cards, the HUD and the recorder: 12, 13, 14, 15, 17, 24, 32, 44, 64.
    - `film` in px of a 1080p frame: 32, 40, 44, 52, 64, 72, 96, 132, 232.
  - In the film, anything the viewer must read is at least 40 px.
- **Space.** A 4 px base: 0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64, 80, 96, 128, 160.
- **Corners.** 0 to 4 px. Nothing rounder, and no circles.
- **Rules.** A 1 px hairline separates rows. An ink rule states something: the top of a table, a chart's zero line, the top of a HUD panel. Film rules are 2 px.
- **Grid.**
  - Film: 12 columns inside 160 px margins with 32 px gutters, every element on the left edge.
  - Card: 540 × 675 CSS px at 2x (the 4:5 shape WhatsApp shows uncropped), with 28 px margins.
- **Motion.** Hard cuts. Overlays fade in over 150 ms. A shot gets at most one push-in: 600 ms, ease-out, up to 1.15x. Nothing bounces, blurs or counts up.

## Components (`packages/design/src/components.ts`)

| Component | Anatomy | Rules |
|---|---|---|
| Card shell | The masthead (the "Dockhand" wordmark, then what this is and when, in words) over a 1 px ink rule | Paper background, fixed 4:5. `FIT_SCRIPT` moves table rows into an "N more" line rather than cut text |
| Title + summary | A title (24 px, 600), then one summary sentence (15 px) | The title says what happened; the summary says what it means and what was checked |
| Display line | One number or short phrase (64 px; 44 px for IDs in mono) | The only thing that must read at phone scale in the film. One per card |
| Data table | Label and value rows on hairlines, under an ink rule | Values may wrap; they are never cut with an ellipsis |
| Change rows | Before, Now, Fixed by | "Fixed by" is words with time: "Muse Spark Open, 2.0 s". The accent marks the one change a model repaired |
| Status | A word: Fixed, Verified, Match, Mismatch, Stopped, Waiting for your answer | Never a symbol. Error color only for a real failure |
| Numbers | Geist Mono, tabular | Money at the ledger's precision: $0.0029, $0.096, $0.30. A true zero is $0.00 |
| Chart primitives (`charts.js`) | Axis, line, bar, direct label, annotation (a thin leader, no arrowhead), footnote | No dots, no legend, no rounded bars. Ink is Dockhand, gray is the comparison, dashed gray is a projection |
| Caption band, lower third | An opaque paper band across the bottom of the frame: a line at 64 px, a fact at 40 px, a source at 32 px | Rendered with alpha (`title-band.mov`) so it sits over real footage |
| HUD panel | A white surface with a rule border and a 2 px ink top rule, 2 px corners, no shadow | A title, a sub line, then rows in words. The accent is the outline of the step Dockhand is acting on |

## Do

- State the finding in the title, the unit in the subtitle, and the source in a footnote.
- Give each surface one line big enough to read when it fills a third of the frame. Everything else is for the reader up close.
- Build hierarchy from size and weight: a masthead, a title, one summary sentence, then hairline tables.
- Say status in words, with who, time and cost: "Fixed · Muse Spark Open · 2.7 s · $0.0029".
- Set numbers and IDs in Geist Mono with tabular figures.
- Label every series where it ends.
- Align everything to the left edge of the grid.

## Don't (checked by `tells()` in `packages/design`)

- Endpoint dots, markers or circles on lines. Circle icons (✓ ✕ ⊗ ◌), circle avatars, status dots.
- Waffle or unit-square grids. A row of stat tiles with a big number over a tiny caption.
- Pill badges. Boxes that are all rounded with the same soft shadow. Glass, glow, gradient, blur.
- Centered hero headlines. Letter-spaced capital eyebrows. Decorative arrows and glyphs. Emoji.
- Ellipsis truncation in anything the reader needs. Shorten the copy or let it wrap.
- Counting-up numbers or bouncy easing. A number on screen is always a measured one.

`assets/video/design.ts` runs `tells()` on every phone card before it renders them.

## Where it is used

| Surface | Code |
|---|---|
| Phone cards | `packages/orchestrator/src/tools/phone-cards.ts` (receipts through `tools/receipts.ts`) |
| Film | `assets/video/src/*.html`. `render.ts` writes `src/tokens.css` from the tokens; the charts load `packages/design/src/charts.js` |
| HUD | `packages/browser/src/hud/hud-page.js` (the same palette, inlined; the page script cannot import) |
| Flight recorder | `apps/gateway/src/recorder/style.ts`, `reveal.ts`, `views.ts` |
