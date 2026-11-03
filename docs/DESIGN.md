# Dockhand design system

One source for every surface Dockhand draws: the WhatsApp cards, the HUD, the flight recorder and the film. The code is `packages/design`; the rendered reference sheet is `var/design/system.png` (`pnpm exec tsx assets/video/design.ts`).

Black ground, white text, one signal lemon, the other high-visibility color of a port's gear. Black is Dockhand speaking. Lemon is Dockhand acting. Every value comes from GitHub's Primer (MIT): color from Primer Brand's dark scale, type from Primer Brand, sizes from Primer Primitives. Real pictures from the run carry the proof, and every card ends in the stub.

## Tokens (`packages/design/src/tokens.ts`)

TypeScript imports `TOKENS`. CSS gets the same values from `cssVariables("ui" | "film")` as `--dh-*` properties. The HUD and the recorder cannot import them, so `hud-page.js` and `recorder/style.ts` repeat the palette.

| Token | Value | Use |
|---|---|---|
| ground | `#000000` | Everything Dockhand says: cards, panels, bands, charts |
| surface | `#262C28` | A raised panel, the stub at a card's foot, the race's terminal |
| text | `#FFFFFF` | Text, lines that carry meaning |
| gray | `#A4AEA6` | Secondary text, labels, comparison data |
| faint | `#7C8980` | Present but not in play |
| hair | `#262C28` | Hairlines, gridlines |
| rule | `#353D37` | Panel borders |
| accent | `#F9E76A` | Where Dockhand acted, or a whole finished job |
| onAccent | `#000000` | Text on lemon |
| onAccentMuted | `#654D02` | Secondary text on lemon (6.4:1) |
| accentStub | `#F4DA38` | The stub of a lemon card |
| error | `#FA383D` | Only a real failure |

- **Lemon.** At most one thing per frame, and only where Dockhand acted. A whole lemon ground is reserved for finished work: the overnight card and the end card. A series and the row, block or bar that carries it count as one thing.
  - On black it works as is (16.7:1).
  - On a white portal page a thin lemon line is about 1.4:1 and disappears. Use lemon there as a fill behind black text (a tag, the row being read back), or as a band around a black line (the control Dockhand will act on). Outlines on the page stay black.
- **Type.** Mona Sans (SIL OFL, the Google Fonts latin subset with its weight and width axes), with Geist Mono for real code and terminals only, never for numbers or labels. Both are bundled in `packages/design/fonts` and never fetched.
  - Two weights: 600 for the one thing a surface says, 400 for the rest. Sentence case.
  - Tracking -0.035em on the display size only; 0 everywhere else.
  - Width: expanded (125%) on the display line only ("Nothing to do."). Everything else is normal width.
  - Figures are proportional. Tabular figures are off: Mona Sans draws them with a slashed zero that reads as code. A counter that must hold still gets a fixed-width box instead.
  - Common ligatures are off: Mona Sans joins "ti" into one dotless glyph.
  - Three scales: `ui` in CSS px for the HUD and recorder, `card` in CSS px of a 540 px card, `film` in px of a 1080p frame.
  - Card: 22 for labels and incidental lines, 28 for everything that must be read, and one hero size per card: 48 (a statement), 56 (a record ID or number) or the 64 display. At most three sizes and two weights on a card.
  - In the film, anything the viewer must read is at least 40 px. Only a source line drops to the 32 px footnote. Recorder pages filmed at 1280 wide reach that at 27 CSS px.
- **Space.** Primer's base-size steps, an 8 px rhythm: 8, 16, 24, 32, 40, 48, 64.
- **Corners.** Square. Nothing anywhere is rounder than 4 px, and the cards use none.
- **Rules.** A hairline separates. A white rule states: a chart's zero line, the top of a recorder section.
- **Grid.** Film: 12 columns inside 160 px margins, 32 px gutters. Card: 540 × 675 CSS px at 2x, Primer Brand's grid at the 768 step: 40 px margins, 32 px gaps, a 64 px header. Pictures run to the edge. Everything left aligned.
- **Motion.** Hard cuts, 150 ms fades, at most one push-in per shot: 600 ms ease-out, up to 1.15x. Nothing bounces, blurs or counts up.

## Mark and stub

The mark is a D with a slot cut into it, a dock for whatever comes in. `mark()` and `lockup()` are in `components.ts`. The lockup (24 px mark, 22 px name, 600) tops every card, and the film closes on the plain wordmark.

The stub is the signature. Every card ends in a band (`surface`, or `accentStub` on a lemon card) with the mark's dock slot cut into its top-left corner: from the card's edge to the text column (40 px), 16 px deep. It holds the proof as up to three fields, a 22 px label over a 28 px value: Values 42 · Invite ACME-7731 · Stops at Final submit. The end card's compliance lines sit in the same shape. `stub()` in `components.ts`.

## Surfaces

| Surface | How it is built | Code |
|---|---|---|
| Phone card | A poster, not a report: seen 290 px wide in a chat, so one hero, one real picture, the proof in the stub. Plan cards show the three values a wrong approval would break; receipts crop the portal's own confirmation panel and keep a record ID on one line. Detail goes in the WhatsApp message | `packages/orchestrator/src/tools/phone-cards.ts` |
| Chart | Title states the finding, subtitle the unit, footnote the source. Dockhand lemon, comparison gray, projection dashed gray. Labels sit where a series ends; no legends, no dots, no rounded bars. Everything ends above y = 880, where the caption lands | `assets/video/src/chart-*.html`, `packages/design/src/charts.js` |
| Title band, captions, labels | Opaque black panels on the grid's left edge, over real footage. A label that marks Dockhand acting is lemon with black text | `assets/video/src/title-band.html`, `scripts/video/lib/overlay.ts` |
| End card | The credits on black, then a hard cut to the wordmark in black on the whole lemon ground, compliance lines in the stub beneath it. No caption covers it | `assets/video/src/endcard*.html` |
| HUD | Black panels on real pages, no shadow. A 2 px lemon top rule while Dockhand acts on a step; the outline on the page is black. When the news is on the page (the repaired element, the submit waiting on the rep, the row being read back) that takes the lemon, as a fill or a band around a black line, and the rule goes neutral | `packages/browser/src/hud/hud-page.js` |
| Flight recorder | Black, flat sections under a white rule, no boxes. Code is monochrome, so the one color on screen is the patch or the pick, as a solid lemon row with black text | `apps/gateway/src/recorder` |

Status is a word with who, time and cost: Fixed by Muse Spark Open in 2.7 s for $0.0029. Money keeps the ledger's precision; a true zero is $0.00.

The quote PDF is the fictional seller's own document, not a Dockhand surface: it stays in Helvetica with its own layout. The mock portals and EspoCRM play other companies' software and never carry Dockhand's look.

## Do

- Design for the size it is seen at. A card is 290 px wide in a chat, so what must be read is 28 CSS px or more, and only labels are 22.
- One hero, one real picture from the run, and the proof in the stub.
- Black is Dockhand speaking. A whole lemon ground means one thing: it finished the work by itself.
- Pictures are real: a screenshot of the page, a frame of the video, edge to edge, cropped so they can be read.
- Say status in words, with who, time and cost.
- Label every series where it ends. Lemon is Dockhand, gray the comparison, dashed gray a projection.
- Align everything to the left edge. Square corners. Hard cuts, 150 ms fades, one push-in per shot.

## Don't (checked by `tells()` in `packages/design`)

- Report layouts: a masthead over tables, a row of stat tiles, three numbers with tiny captions.
- Monospace or tabular figures for numbers or labels.
- Warm off-white with an orange accent, the default of generated design. Glass, glow, gradient, blur, rounded cards.
- Endpoint dots, circle icons, status dots, pill badges, boxes with the same soft shadow.
- Centered hero headlines, letter-spaced capital eyebrows, decorative arrows and checkmarks, emoji.
- Ellipsis truncation in anything the reader needs. Counting-up numbers, bouncy easing.
- A thin lemon line on a white page.

`assets/video/design.ts` runs `tells()` on every phone card before it renders them.
