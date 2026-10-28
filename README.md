# Dockhand

**Meta's computer use writes its own automation, and repairs it when the app changes.**

Show Dockhand a web workflow once, as a plain screen recording or just a goal. Muse computer use does it the first time and records exactly what it touched. That run compiles into a program that replays in seconds with no model calls. When the app's UI changes, a repair ladder fixes the broken step, verifies it, and saves a new version of the skill. Sales reps trigger, teach and approve everything from WhatsApp.

Built for the Meta Global AI Developer Hackathon (Indie track, "Build for Your World"). Everything in this repository was built during the event, Oct 27 to Nov 4, 2026.

## Why

In Brazil, India and much of LatAm and Southeast Asia, B2B deals move through WhatsApp: voice notes, photos of signed forms, PDFs from procurement. The follow-up work lands in web portals that give partners and suppliers a login, not an API: distributor deal registration, buyer supplier-onboarding portals, legacy CPQ. Reps retype the same data at night. Dockhand lets them forward the message instead.

## How it works

```
teach (video or goal) ─► draft ─► first run: Muse computer use ─► trace ─► compile + Muse Spark annotation ─► skill v1
                                                                                                            │
WhatsApp message ─► understand ─► plan ─► Approve ─► replay (0 model calls) ─► read back every field ─► Approve submit ─► receipt
                                                       │ a step no longer matches the page
                                                       ▼
            heal ladder: other stored selector ─► fingerprint similarity ─► Muse Spark Open ─► Muse computer use ─► ask the rep
                                                       │ fixed
                                                       ▼
                          canary dry runs ─► skill v(n+1) with a readable diff (old version kept for rollback)
```

- **Teach from a video.** The recording is sent to WhatsApp as a document (no recompression). Muse Wonder turns it into a draft: steps that reference typed parameters by name, the submit control, and what success looks like. Values seen in the video are never typed into a real run.
- **First run with computer use.** Fixed 1280×800 viewport; before every click the harness re-checks the element under the pointer; every action is recorded with ranked selector candidates for the element it touched.
- **Compile.** The trace becomes a parameterized program built from end-state values, not keystrokes. Muse Spark writes step intents, parameter names and the success check; code verifies them, then the program must replay correctly twice in dry-run mode, once with the original values and once with fresh ones, before it is saved.
- **Replay.** No model calls. Before submitting, every filled value is read back from the page and compared with what the skill meant to write. Any mismatch stops the run.
- **Heal.** Cheapest rung first: another stored selector, fingerprint similarity (both free), Muse Spark Open picking the element from a pruned accessibility list (text only), Muse computer use with a narrow goal and at most 8 actions. When the page needs information the skill doesn't have, such as a new required field, Dockhand asks the rep once in WhatsApp and adds the parameter. A healed skill must pass canary dry runs before it is activated.

## Safety and approvals

- Nothing is submitted without a tap. The harness enforces this, not the model: a click or Enter on a submit control is blocked until the rep approves, and a network guard holds any POST, PUT, PATCH or DELETE to the portal until an approval exists.
- Approval cards show the filled form and the values read back from the page.
- Computer-use safety checks from the API are routed to the rep as approvals.
- Only allow-listed reps can use it. Dockhand never messages buyers; it drafts replies for the rep to forward.

## Meta models, one job each

| Model | Job |
|---|---|
| Muse Voice Transcribe | Code-switched Portuguese/English voice notes |
| Muse Spark 1.3 | Reading photos and PDFs, understanding requests, annotating compiled skills, computer use (first runs and repairs) |
| Muse Wonder | Turning a screen recording into a skill draft |
| Muse Spark Open (via Baseten) | Heal rung: picks the replacement element from the page's accessibility list, text only |

Every call is recorded in a ledger with tokens, images, latency and cost at Standard list prices. Receipts split intake cost (transcribing, reading) from execution cost.

Built with Muse Spark Open.

## Results so far

Live, real Meta API calls at Standard list prices, on the mock partner portal (Oct 28, 2026; field-level ground truth from the portal's stored submission):

| What | Model | Runs | Result |
|---|---|---|---|
| First run with computer use, deal registration | muse-spark-1.3, low effort | 3 | 3/3 correct, 13/13 fields each; 29–31 actions; 74–116 s; $0.11–$0.20 per run |
| First run with computer use, supplier onboarding from a procurement PDF (multi-step, about 40 fields, 2 uploads), zero-shot | muse-spark-1.3, low effort | 3 | 3/3 correct, 40/40 fields each; 85–98 actions; 249–310 s; $0.32–$0.49 per run |
| The compiled supplier skill replayed for a second buyer | none | 1 | 40/40 fields, 0 model calls, 4.8 s |
| Heal rung 2 on a renamed submit button | Muse Spark Open (Baseten) | 4 | 4/4 healed, about 3 s and $0.002 each |
| Heal rungs 2–3 on six seeded UI changes | Muse Spark Open, then muse-spark-1.3 | 6 | 4/6 healed; the 2 widget-type changes stopped before writing; 0 wrong submissions |

Measured with **no model at all** (deterministic rungs only):

| Suite | Runs | Result |
|---|---|---|
| Replay, randomized synthetic data | 50 | 50 correct, field by field against the portal's stored submission |
| Seeded UI mutations (11 operators × 5 seeds) | 55 | 40 correct (10 of them healed for free), 5 correct safe stops on a new required field, 10 stopped without writing (renamed button, widget swap: these need a model rung), **0 silent wrong writes** |

Charts and raw summaries: [`evals/results/`](evals/results/). Reproduce with `pnpm eval --suite replay --skill caravela --n 50` and `pnpm eval --suite mutation --skill caravela`.

## What is real and what is simulated

| Real | Simulated |
|---|---|
| Every Meta model call (Responses API, native computer tool, Voice Transcribe, Muse Spark Open on Baseten) | The two portals: "Caravela Partner Hub" and a multi-tenant supplier portal, built for this project with fictional companies |
| WhatsApp Cloud API in the demo | All data: companies, people, documents (sample W-9 and insurance certificate in our own layouts) |
| HubSpot test portal writes | The WhatsApp emulator, used only in development and tests |
| The compiler, runner, heal ladder and evals | The scripted computer-use model, used only in CI; its runs never appear in reported model numbers |

## Run it

Requirements: Node 22.13+, pnpm 10, ffmpeg on PATH.

```bash
pnpm install
npx playwright install chromium
cp .env.example .env        # fake modes work without any keys
pnpm dev                    # gateway + WhatsApp emulator (/dev/chat) + both portals
pnpm test                   # unit, integration and end-to-end tests
pnpm run preflight          # checks keys, models, ffmpeg, Chromium, ports
```

Set `META_MODE=live`, `WHATSAPP_MODE=cloud` and `CRM_MODE=hubspot` with the keys in `.env` for the real setup.

## Repository

| Path | What |
|---|---|
| `packages/core` | Contracts, config, SQLite, artifacts, cost ledger |
| `packages/whatsapp` | Webhook parsing and signatures, Graph API client, emulator |
| `packages/meta` | Model gateway: structured output, files, transcription, computer use, open weights, cassettes |
| `packages/browser` | Browser pool, computer-use loop, trace capture, commit and write guards |
| `packages/skills` | Compiler, runner, read-back, heal ladder, versioning, Playwright export |
| `packages/orchestrator` | Intake, understanding, plans, approvals, flows, receipts, HubSpot, quotes |
| `packages/evals` | Synthetic cases, ground-truth scoring, charts |
| `apps/portals` | The two mock portals with seeded UI mutations |
| `apps/gateway` | The single dev process |

Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Prior art

Record-and-replay with an agent fallback exists: browser-use's workflow-use records through its own recorder and falls back to an agent, and UiPath sells a Healing Agent for enterprise RPA. Dockhand's focus is different: teaching from an ordinary screen recording, a heal ladder measured per rung against UI changes it did not design, read-back verification so a heal can never silently write a wrong field, and asking the human when the app needs new information.
