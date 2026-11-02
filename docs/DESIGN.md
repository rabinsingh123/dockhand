# Dockhand design system

One source for every surface Dockhand draws: the WhatsApp cards, the HUD, the flight recorder and the film. The code is `packages/design`; the rendered reference sheet is `var/design/system.png` (`pnpm exec tsx assets/video/design.ts`).

Black ground, white text, one signal orange, the color of a port's high-visibility gear. Black is Dockhand speaking. Orange is Dockhand acting. Type is set big and sparse; real pictures from the run carry the proof.

## Tokens (`packages/design/src/tokens.ts`)

TypeScript imports `TOKENS`. CSS gets the same values from `cssVariables("ui" | "film")` as `--dh-*` properties. The HUD and the recorder cannot import them, so `hud-page.js` and `recorder/style.ts` repeat the palette.

| Token | Value | Use |
|---|---|---|
| ground | `#0A0A0A` | Everything Dockhand says: cards, panels, bands, charts |
| surface | `#171717` | A raised panel: code, the race's terminal |
| text | `#FFFFFF` | Text, lines that carry meaning |
| gray | `#A3A3A3` | Secondary text, comparison data |
| faint | `#6F6F6F` | Present but not in play |
| hair | `#2A2A2A` | Hairlines, gridlines |
| rule | `#404040` | Panel borders |
| accent | `#FF4F00` | Where Dockhand acted, or a whole finished job |
| onAccent | `#0A0A0A` | Text on orange |
| error | `#FF5C4D` | Only a real failure |

- **Orange.** At most one thing per frame, and only where Dockhand acted. A whole orange ground is reserved for finished work: the overnight card and the end card. A series and the row, block or bar that carries it count as one thing.
- **Type.** Archivo, with Geist Mono for real code and terminals only, never for numbers or labels. Both are bundled in `packages/design/fonts` (SIL OFL) and never fetched.
  - Archivo 700 at tight tracking for statements, 500 for sentences, sentence case.
  - Three scales with one ratio: `ui` in CSS px for the HUD and recorder, `card` in CSS px of a 540 px card (nothing under 20), `film` in px of a 1080p frame.
  - In the film, anything the viewer must read is at least 40 px. Only a source line drops to the 32 px footnote. Recorder pages filmed at 1280 wide reach that at 27 CSS px.
- **Space.** A 4 px base.
- **Corners.** 0 to 4 px.
- **Rules.** A hairline separates. A white rule states: a chart's zero line, the top of a recorder section.
- **Grid.** Film: 12 columns inside 160 px margins, 32 px gutters. Card: 540 × 675 CSS px at 2x, 30 px margins, pictures to the edge. Everything left aligned.
- **Motion.** Hard cuts, 150 ms fades, at most one push-in per shot: 600 ms ease-out, up to 1.15x. Nothing bounces, blurs or counts up.

## Mark

A D with a slot cut into it, a dock for whatever comes in. `mark()` and `lockup()` in `components.ts`. The lockup tops every card; the film closes on the plain wordmark.

## Surfaces

| Surface | How it is built | Code |
|---|---|---|
| Phone card | A poster, not a report: seen 290 px wide in a chat, so one statement, one real picture, one line of proof. Detail goes in the WhatsApp message | `packages/orchestrator/src/tools/phone-cards.ts` |
| Chart | Title states the finding, subtitle the unit, footnote the source. Dockhand orange, comparison gray, projection dashed gray. Labels sit where a series ends; no legends, no dots, no rounded bars. Everything ends above y = 880, where the caption lands | `assets/video/src/chart-*.html`, `packages/design/src/charts.js` |
| Title band, captions, labels | Opaque black panels on the grid's left edge, over real footage | `assets/video/src/title-band.html`, `scripts/video/lib/overlay.ts` |
| End card | The credits on black, then a hard cut to the wordmark in black on the whole orange ground, compliance lines beneath it. No caption covers it | `assets/video/src/endcard*.html` |
| HUD | Black panels on real pages, no shadow. A 2 px orange top rule while Dockhand acts on a step; the outline on the page is black. When the news is on the page (the repaired element, the submit waiting on the rep, the row being read back) that takes the orange and the rule goes neutral | `packages/browser/src/hud/hud-page.js` |
| Flight recorder | Black, flat sections under a white rule, no boxes. Code is monochrome, so the one color on screen is the patch or the pick, as a solid orange row with black text | `apps/gateway/src/recorder` |

Status is a word with who, time and cost: Fixed by Muse Spark Open in 2.7 s for $0.0029. Money keeps the ledger's precision; a true zero is $0.00.

## Do

- Design for the size it is seen at. A card is 290 px wide in a chat, so nothing on it goes below 20 CSS px.
- One statement, one real picture from the run, one line of proof.
- Black is Dockhand speaking. A whole orange ground means one thing: it finished the work by itself.
- Pictures are real: a screenshot of the page, a frame of the video, edge to edge, cropped so they can be read.
- Say status in words, with who, time and cost.
- Label every series where it ends. Orange is Dockhand, gray the comparison, dashed gray a projection.
- Align everything to the left edge. Corners 0 to 4 px. Hard cuts, 150 ms fades, one push-in per shot.

## Don't (checked by `tells()` in `packages/design`)

- Report layouts: a masthead over tables, a row of stat tiles, three numbers with tiny captions.
- Monospace for numbers or labels.
- Warm off-white with an orange accent, the default of generated design. Glass, glow, gradient, blur.
- Endpoint dots, circle icons, status dots, pill badges, boxes with the same soft shadow.
- Centered hero headlines, letter-spaced capital eyebrows, decorative arrows and checkmarks, emoji.
- Ellipsis truncation in anything the reader needs. Counting-up numbers, bouncy easing.

`assets/video/design.ts` runs `tells()` on every phone card before it renders them.
