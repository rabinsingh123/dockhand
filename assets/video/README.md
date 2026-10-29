# Demo video motion graphics

Four clips for the demo video (storyboard shots 2, 8 and 9). 1920×1080, 30 fps, H.264 High, yuv420p, BT.709, no audio.

| Clip | Shot | Length | What it shows |
|---|---|---|---|
| `title.mp4` | 2 | 8 s | "In LatAm and India, B2B deals happen in WhatsApp", one sourced stat, then the Dockhand mark and "Automation that maintains itself." |
| `chart-cost.mp4` | 8 | 10 s | Cumulative cost, close-up on the measured runs, then a zoom out to all 93; ends on "$0.26 vs $10.30 over 93 runs" |
| `chart-heals.mp4` | 8 | 8 s | The heal ladder on held-out drift, built rung by rung; ends on "42/42 unseen UI changes handled · 0 wrong writes" |
| `endcard.mp4` | 9 | 6 s | Build dates, real vs simulated, "Built with Muse Spark Open", repo URL |

## Re-render

```bash
pnpm exec tsx assets/video/render.ts                          # all four clips, about 2 minutes
pnpm exec tsx assets/video/render.ts endcard                  # one clip
pnpm exec tsx assets/video/render.ts chart-cost --still 6.5   # PNG frames only, for checking a layout (--out <dir>)
```

Needs ffmpeg and ffprobe on PATH and Playwright's Chromium (`npx playwright install chromium`). Pages load from `file://`, so no server or port is involved. The type is Windows 11's Segoe UI Variable and Consolas; on other systems the pages fall back to system fonts and will look different, so render on Windows.

To preview a clip, open its page in `src/` in a browser: it plays in real time and loops, and `?t=4.2` freezes it at 4.2 s.

## How it works

- Each page in `src/` draws itself as a pure function of time t (`src/runtime.js`): no CSS animations, transitions, timers or randomness.
- `render.ts` loads the page at a 1920×1080 viewport, steps a virtual clock (t = n/30), captures every frame as a lossless PNG and pipes it to ffmpeg, so machine speed never changes a frame.
- After each clip it draws two frames again, out of order, and compares them with the first pass. A page that depends on wall time fails the render. Chromium's raster caches can leave a few anti-aliased edge pixels a few levels off; those are reported, not treated as failures.
- ffprobe then checks codec, size, pixel format, frame rate and frame count.

## Where the numbers come from

- Cost and heal clips: every number on screen comes from `evals/results/live-headline.json`, through `src/data.js`, which `render.ts` regenerates on each run. The shape of the cost curve comes from the raw rows in `evals/results/live/`, derived the same way as `scripts/live/headline.ts`. The render stops if the rows and the headline file disagree. Nothing counts up, so no frame shows an in-between number.
- Title stat: `docs/research/impact-facts.md`, fact 1.4 (Meta Newsroom, 18 Sep 2025, citing Kantar's 2025 report). The source says "chatting with businesses", not WhatsApp, and the card quotes it that way.
- End card list: `README.md`, "What is real and what is simulated".

## Swapping the repo URL

Edit `REPO_URL` at the top of the script in `src/endcard.html`, then run `pnpm exec tsx assets/video/render.ts endcard`. A longer URL shrinks to fit its row.
