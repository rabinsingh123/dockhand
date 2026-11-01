# Demo video motion graphics

Clips for the demo video (storyboard shots 2, 8 and 9), in the film's light, editorial look: paper `#F6F5F1`, ink `#111111`, one gray `#6B6B6B`, hairlines `#E3E1DB`, and one accent `#FF4F00`, used at most once per frame and only where Dockhand acted. Type is Geist and Geist Mono (SIL OFL, bundled in `fonts/`), weight 600 at -2% tracking for display, with tabular figures. There are no gradients, glows, blur, icons or count-ups. Motion is limited to hard cuts and overlays that fade in over 150 ms. Must-read text is at least 40 px.

All clips are 1920×1080 at 30 fps. The `.mp4` files are H.264 High, yuv420p, BT.709, with no audio. The `.mov` file is QuickTime Animation with alpha.

| Clip | Shot | Length | What it shows |
|---|---|---|---|
| `title.mp4` | 2 | 8 s | Full frame: "In LatAm and India, B2B deals happen in WhatsApp.", the sourced stat, then a hard cut to the wordmark |
| `title-band.mov` | 2 | 6 s | The same line and stat as a caption band with alpha, laid over real footage (the WhatsApp thread) |
| `chart-proof.mp4` | 8 | 9 s | One frame of proof: the same 42 changes (recorded script vs Dockhand) beside the cost curve |
| `chart-baseline.mp4` | 8 | 8 s | 42 UI changes, one square each: 21/42 with one selector per step, 33/42 as exported, 42/42 Dockhand |
| `chart-cost.mp4` | 8 | 10 s | $0.26 vs $10.30 over 93 runs; computer use solid through run 8, dashed after |
| `chart-heals.mp4` | 8 | 8 s | The heal ladder: 100 of 102 repairs used no closed model (84 free, 16 Muse Spark Open, 2 computer use) |
| `endcard.mp4` | 9 | 8 s | What is real and what is simulated, then a hard cut to the wordmark with the compliance lines (the last frame) |
| `endcard-wordmark.mp4` | any | 3 s | The wordmark and tagline only, for a hard cut |

## Re-render

```bash
pnpm exec tsx assets/video/render.ts                          # every clip, a few minutes
pnpm exec tsx assets/video/render.ts endcard                  # one clip
pnpm exec tsx assets/video/render.ts chart-cost --still 6.5   # PNG frames only, for checking a layout (--out <dir>)
pnpm exec tsx assets/video/design.ts                          # design review: every phone card, style frames, stills, var/design/review.png
```

The render needs ffmpeg and ffprobe on PATH, plus Playwright's Chromium (`npx playwright install chromium`). Pages load from `file://`, so no server or port is involved. To preview a clip, open its page in `src/` in a browser. It plays in real time and loops, and `?t=4.2` freezes it at 4.2 s.

`design.ts` builds the phone cards with the same functions the flows use (`packages/orchestrator/src/tools/phone-cards.ts`). It feeds them a rehearsal's own rows, by default `var/recordings/rh-cassette-2/var`; use `--from <var dir>` for another. It makes no model calls.

## How it works

- Each page in `src/` draws itself as a pure function of time t (`src/runtime.js`). It uses no CSS animations, transitions, timers or randomness. The only moves are `cut`, `fade` (150 ms) and one `push` per shot.
- `render.ts` loads the page at a 1920×1080 viewport and steps a virtual clock (t = n/30). It captures every frame as a lossless PNG and pipes it to ffmpeg, so machine speed never changes a frame. Alpha clips are captured with a transparent page background.
- After each clip, `render.ts` draws two frames again out of order and compares them with the first pass. A page that depends on wall time fails the render. ffprobe then checks the codec, size, pixel format, frame rate and frame count.

## Where the numbers come from

- Charts: every number on screen comes from `evals/results/live-headline.json` and `evals/results/baseline-recorded-script.json` (section 4 of `live-headline.md`), through `src/data.js`, which `render.ts` regenerates on each run. The shape of the cost curve comes from the raw rows in `evals/results/live/`, derived the same way as `scripts/live/headline.ts`. The render stops if the rows, the headline and the baseline file disagree.
- Title stat: `docs/research/impact-facts.md`, fact 1.4 (Meta Newsroom, 18 Sep 2025, citing Kantar's 2025 report). The source says "chatting with businesses", not WhatsApp, and the card quotes it that way.
- End card list: `README.md`, "What is real and what is simulated".

## Swapping the repo URL

Edit `REPO_URL` at the top of the script in `src/endcard.html`, then run `pnpm exec tsx assets/video/render.ts endcard`.
