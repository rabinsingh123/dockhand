# Dockhand architecture

Dockhand learns a web workflow once, runs it the first time with Meta's computer use, compiles that run into a deterministic program, replays it in seconds, and repairs the program when the app's UI changes. Sales reps trigger, teach and approve everything from WhatsApp.

Contracts (every cross-package type) live in `packages/core/src/contracts/` and are the source of truth. This document explains the design around them.

## 1. Packages

| Package | Owns | May import |
|---|---|---|
| `packages/core` | Contracts; `loadConfig`, `openDb` (node:sqlite + `schema.sql`), `createArtifactStore`, `createLedger`, clocks, `ulid`, logger | zod |
| `packages/whatsapp` | Webhook parsing and signature check, the one `WhatsAppClient` (Graph API), and the emulator (a fake Graph API + `/dev/chat` page) | core |
| `packages/meta` | `ModelGateway`: Responses API (structured output, files, video), Voice Transcribe, live computer-use sessions, open-weights client (Baseten), cassette record/replay, fake gateway | core |
| `packages/browser` | Browser pool, computer-use loop, trace capture, commit guard, write guard, scripted CU model, `renderHtml` | core |
| `packages/skills` | Compiler, templates, runner (read-back, free heals), heal-ladder repairers, ask-rep, skill store, diff, Playwright export | core, browser |
| `packages/orchestrator` | Intake, understanding, `buildPlan`, job state machine, approval broker, flows, tools (CRM fake + HubSpot, quotes, receipts), teach pipeline | core, browser, skills |
| `packages/evals` | Case generators, suites, ground-truth scoring, charts, CLI | core, browser, skills, meta, portals |
| `apps/portals` | Mock portals: Caravela Partner Hub (v1/v2), multi-tenant supplier portal (acme, globex), seeded UI mutations, per-context sessions, ground-truth APIs | (standalone) |
| `apps/gateway` | One dev process: webhook routes, emulator, portals, wiring, `pnpm dev`, `pnpm doctor`, `pnpm demo:reset` | everything |

Rules: construction by injection (`createX(deps)`), no module-level state; plain JSON crosses package boundaries (Playwright `Page` is the one exception); anything crossing a process or model boundary has a zod schema.

## 2. The loop

```
teach (video or goal) ─► SkillDraft ─► first run: computer use ─► Trace ─► compile + annotate ─► Skill v1
                                                                                             │
WhatsApp request ─► understand ─► plan ─► Approve ─► replay (0 model calls) ─► read-back ─► Approve commit ─► receipt
                                                         │ step fails
                                                         ▼
                    heal ladder: fallback candidate ─► fingerprint similarity ─► Muse Spark Open (text) ─► Muse computer use ─► ask the rep
                                                         │ fixed
                                                         ▼
                                     canary dry-runs ─► Skill v(n+1) + changelog ─► WhatsApp diff (old version kept for rollback)
```

### 2.1 Teach
- Input: an mp4 sent as a WhatsApp video or document (documents avoid recompression; inbound media up to 100 MB). Audio, if present, is extracted with ffmpeg and transcribed separately (Spark 1.3 audio is not fully supported).
- `teach` call (Muse Wonder, Spark 1.3 fallback) returns a `SkillDraft`: goal, steps that reference params **by name**, typed params, the commit control's name, the success description. Values seen in the video go to `observedValues` for the rep's confirmation and are never sent to a run (otherwise the agent re-types the video's company).
- The draft is saved; the first real request for that portal runs agentically, guided by the draft; its trace compiles v1.

### 2.2 First run (computer use)
- Meta Responses API, native `computer` tool, `previous_response_id`, plus function tools `request_commit`, `attach_file`, `propose_target`.
- Fixed viewport 1280×800, device scale factor 1, `scale: 'css'` screenshots, scrollbars hidden; every screenshot is asserted to be exactly 1280×800.
- Each screenshot is paired with an element map. Before every click the harness re-resolves the element under the point; if it no longer matches what the batch intended, the batch stops.
- Batches also stop on URL change, `scrollY` change, or a new dialog.
- Trace capture before every action: `elementFromPoint` → nearest interactive ancestor → descriptor (accessible name from `ariaSnapshot`, label, testid, placeholder, section) → ranked candidates, keeping only candidates that resolve to exactly that element. Form values are snapshotted before every action so the compiler sees end states, not keystrokes.
- Commit guard (harness-enforced, not model-trusted): a click or Enter on a commit target without an approval token is not executed; the model is told to call `request_commit`. The approval card carries the screenshot and a read-back of every field.
- Write guard (network backstop): POST/PUT/PATCH/DELETE to the portal origin are held by `page.route` until a commit approval token exists; one token releases one write.
- `pending_safety_checks` go to WhatsApp as approvals; acknowledged checks are echoed.
- Session rollover after N screenshots (50-images-per-request cap). Long runs post progress to WhatsApp every ~5 actions.

### 2.3 Compile ("the model writes its own automation")
1. Deterministic normalization: drop noise (scrolls, moves, misclicks that changed nothing, focus clicks), merge click+type into `fill` using final field values, combobox open+option into `select`, file chooser into `upload`, navigations into `waitFor`.
2. Templating: values matched to params with formatters (dates, pt-BR numbers, phones, case, combobox option names, URL segments). Two params sharing a value is a warning.
3. Muse Spark `compile_annotate`: param names and descriptions, a plain-language `intent` per step (used by repair), the commit step, the success check and ID regex. The model proposes; code verifies.
4. Verification: the compiled skill is replayed in dry-run mode up to the commit step twice, once with the first run's values and once with fresh synthetic values, and must read back correctly both times. Otherwise it is not saved.

### 2.4 Replay
- Zero model calls on the happy path. Receipt text comes from templates; IDs from the compiled regex.
- Target resolution: strong candidates combined into one `or()` locator with one deadline, then a fingerprint similarity check on the matched element (role must match; label/name similarity above threshold). Disagreement between candidates escalates instead of trusting the top one.
- Read-back before commit: every filled, selected and checked value is read from the DOM and compared with what the skill meant to write. Any mismatch stops the run before the commit (`READBACK_MISMATCH`).
- Commit steps always pause for approval (eval auto-approve works only against localhost portals).
- If the success check times out after a commit, the outcome is `unknown` and the commit is never re-clicked.

### 2.5 Heal ladder
| Rung | What | Cost |
|---|---|---|
| fallback | another stored candidate resolves uniquely and matches the fingerprint | free |
| similarity | fingerprint similarity over all interactive elements, with threshold and margin | free |
| open_weights | Muse Spark Open (Baseten) gets the step intent, the old fingerprint and a pruned accessibility list (text only) and picks the element; harness verifies | cents |
| computer_use | Muse computer use, narrow goal, ≤8 actions; commit steps run in `propose_only` mode (the harness clicks after approval) | dimes |
| ask_rep | the page requires information the skill has no param for (e.g. a new required field): ask once in WhatsApp, add the param, insert the step | a tap |

Validation errors from bad data are never sent to repair. A healed step is re-verified by continuing the run; a patched skill must pass canary dry-runs before it is activated. Evals never persist heals.

## 3. Orchestration
- Webhook: verify `X-Hub-Signature-256` over raw bytes, always 200 once verified, dedupe by wamid inside the job-creation transaction, ignore statuses, allow-list reps before any download or model call, download media immediately.
- Attach rule (no timers): a media message starts a new job; a reply to a Dockhand message attaches to that message's job; a text from a rep with a job awaiting input or a pending plan gate attaches to it.
- Understanding: one structured call returns a flat `Understanding`; `buildPlan()` is deterministic per intent.
- Job state machine and gates as in `contracts/orchestrator.ts`; button ids `g:<gateId>:<a|r|e>`; gates have TTLs, late taps get a one-line reply; boot sweep fails in-flight jobs and expires their gates.
- Browser leases have TTLs; at most 4 open contexts.
- Writes to external systems (HubSpot) record a `tool_calls` row before the HTTP call; POSTs are never auto-retried.
- Time: injected clock; rep time zone `America/Sao_Paulo`; params normalized (ISO dates, plain numbers) and formatted at fill time.

## 4. Storage
- SQLite via `node:sqlite` (no native build): `var/dockhand.sqlite` for the app, `var/evals.sqlite` for evals. WAL, busy timeout, foreign keys. Schema in `packages/core/src/schema.sql` (tables: reps, messages, jobs, job_events, gates, tool_calls, skill_drafts, skills, runs, run_steps, model_calls, artifacts).
- Artifacts: content-addressed files under `var/artifacts/ab/<sha256>.<ext>`, written temp-then-rename; paths POSIX and relative to `var/`. The data dir is resolved from the workspace root, never from `cwd`.
- Screenshots: agentic runs keep every batch; replays keep failures and the final page; evals keep failures only.

## 5. Models
| Job | Model |
|---|---|
| Voice notes (pt/en code-switching) | muse-voice-transcribe-1.0 (OGG/Opus → 16 kHz mono WAV via ffmpeg first) |
| Photo/PDF extraction, understanding, compile annotation | muse-spark-1.3 |
| Teach from video, computer-use repair | muse-wonder-1.0 (fallback muse-spark-1.3) |
| First-run computer use | configurable, chosen by measurement |
| Heal rung 2 | Muse Spark Open via Baseten, reasoning effort low, JSON validated by us |

Every call goes through `ModelGateway` and lands in the `model_calls` ledger (provider, model, tokens, images, latency, cost at Standard list price). Receipts and charts split intake cost from execution cost. Scripted and cassette runs are labeled by provider and never appear in reported numbers.

## 6. Modes and safety
`META_MODE=live|record|cassette|fake`, `WHATSAPP_MODE=cloud|emulator`, `CRM_MODE=hubspot|fake`. Live modes fail at boot on missing secrets; the dev process prints a mode banner. Secrets only in `.env`. No request bodies or base64 images in logs.

## 7. Conventions
- TypeScript, ESM, `tsx` (no build step), vitest, biome. Packages export `./src/index.ts`.
- The repo path contains a space: spawn processes with `execFile` and argument arrays, never shell strings.
- Tests: unit tests are pure and fast; integration tests use Playwright + portals on port 0 + the emulator + the scripted model; no pixel goldens (JSON/DOM goldens only); no sleeps (use `drain()` and `waitFor`).
- Synthetic data only. Fictional companies: Tidewater Cloud (us), Caravela (distributor), Acme Group and Globex Industrial (buyers).
