# Meta Model API: verified notes (read 2026-10-27 from dev.meta.ai docs)

All pages are on dev.meta.ai. Re-check the page before relying on a detail that matters.

## Basics
- Base URL `https://api.meta.ai/v1`, bearer auth, env `MODEL_API_KEY`. No SDK reads `MODEL_API_KEY` by itself: pass it explicitly. (/docs/overview, /docs/sdks)
- OpenAI SDK compatible (Responses + Chat Completions). Anthropic SDK: `base_url=https://api.meta.ai`, key as `auth_token`; responses start with a `redacted_thinking` block, so never read `content[0]` blindly.
- Responses API is "the recommended default for new work… agentic and coding workloads". Chat Completions does not carry reasoning across turns. (/docs/protocols)
- Model IDs (/docs/models): `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-wonder-1.0` (preview, Standard mode only), `muse-voice-transcribe-1.0`, `muse-image-1.0`, `sam-3.1`.
- Context 1,048,576 tokens (Wonder and Spark).
- Reasoning effort: minimal / low / medium / high / xhigh / max. `"none"` returns HTTP 400 on Wonder and Spark. Contributor has no `max`.
- `parallel_tool_calls` defaults true.
- **`tool_choice` only accepts `"auto"`.** `"none"`, `"required"`, named function: HTTP 400. To force a structured result, use structured output, not a forced tool call.
- Structured output: Responses `text.format` (json_schema), Chat Completions `response_format`. Decoding is constrained, output is guaranteed to conform. Recursive schemas: 400. Tool-call arguments are NOT guaranteed to validate: validate them yourself (zod).
- Prompt caching is automatic.
- Built-in `web_search` tool: $2.50 / 1k queries, Responses and Messages only.
- Images only count in **user-role** messages (computer-use screenshots go in `computer_call_output`).
- **Max 50 images per request; more returns HTTP 400.** (/docs/image-understanding) Unknown whether screenshots chained via `previous_response_id` count. Keep computer-use sessions short; roll over to a fresh response with a text summary.
- Plain image grounding returns a normalized 0–1000 grid. The native computer tool uses **pixel coordinates of the last screenshot sent**.
- Contributor mode: "Your content may be used to train future Meta models." Synthetic data only. 150 RPM cap.

## Pricing (/docs/pricing-rate-limits), per 1M tokens
| Model | Input | Output | Cached input |
|---|---|---|---|
| muse-wonder-1.0 | $4.00 | $20.00 | $0.20 |
| muse-spark-1.3 (Standard) | $1.25 | $4.25 | $0.15 |
| muse-spark-1.3-contributor | $0.10 | $0.20 | $0.002 |
- Voice Transcribe $0.18 per audio hour. Muse Image $0.01/image. SAM 3.1 $2.50/1k images.
- Rate limits per team: Wonder/Spark 3,000 RPM, 4M TPM. Contributor 150 RPM, 3M TPM.
- ~1280px screenshot ≈ 1,300–1,500 input tokens.

## Speech to text (/docs/speech-to-text, /docs/api-reference/voice/schemas)
- File endpoint `POST /v1/asr/transcribe`, multipart. Audio: mono, 16-bit PCM, 16 kHz or 24 kHz, `audioEncoding` enum is `WAV` only. **WhatsApp voice notes are OGG/Opus: convert with `ffmpeg -i in.ogg -ac 1 -ar 16000 -c:a pcm_s16le out.wav`.**
- >32 MB → 413. >10 min → 400.
- 25 languages with code-switching, Portuguese included. `"languageBias": ["Portuguese","English"]`. Keywords bias recognition but do not guarantee spelling.
- Output: turn-level timestamps only. No word timestamps, no confidence scores.
- Realtime `wss://api.meta.ai/v1/asr/realtime` exists (not needed).

## Video understanding (/docs/video-understanding, /docs/file-handling)
- **mp4 only.** Inline up to 50 MB; Files API up to 1 GiB.
- Recommended: upload with Files API `purpose: "user_data"`, reference via `input_file`. Or `input_video` with public URL / base64 data URL (`fps` field optional, backend default otherwise).
- Silent screen recordings are valid input.
- **Audio understanding in Muse Spark 1.3 "is currently not fully supported."** For narrated teach videos: extract the audio track with ffmpeg, send to Voice Transcribe, pass the transcript (with turn timestamps) as text alongside the video.
- No per-video price or max duration documented. Use `POST /v1/responses/input_tokens` to count.

## Computer use (/docs/computer-use + Responses schemas)
- **No hosted VM.** The client runs the browser (Playwright is named as a driver) and executes actions. Responses API is the only supported endpoint.
- Tool: `tools: [{"type": "computer"}]` (no display size or environment fields). Can be combined with function tools.
- First request:
  ```
  model, instructions=<system prompt>, tools=[{"type":"computer"}, ...function tools],
  input=[{role:"user", content:[{type:"input_text", text: task}, {type:"input_image", image_url:"data:image/png;base64,..."}]}]
  ```
- Output item: `{type:"computer_call", id, call_id, actions:[...], pending_safety_checks:[{id, code, message}], status}`. The schema also has an optional singular `action`: handle both.
- Actions (integer pixel coords in the last screenshot's space; (0,0) top-left):
  - `click` {button: left|right|wheel|back|forward, x, y}
  - `double_click` {x, y}
  - `drag` {path: [{x,y}, ...]}
  - `keypress` {keys: [...]}
  - `move` {x, y}
  - `scroll` {x, y, scroll_x, scroll_y}
  - `type` {text}
  - `screenshot`
  - `wait`
- Execute the batch in order, then take ONE screenshot. "Stop the batch early if an action fails, the page navigates unexpectedly, or a modal changes the screen." Keep screenshot size stable; screenshot the viewport, not the full page.
- Reply item:
  ```
  {type:"computer_call_output", call_id, acknowledged_safety_checks:[...],
   output:{type:"computer_screenshot", image_url:"data:image/png;base64,..."}}
  ```
  PNG or JPEG; MIME must match bytes; max 25 MiB. `file_id` accepted instead of `image_url`.
- Safety checks: echo approved ones in `acknowledged_safety_checks`. "Treat a safety check as a decision point in your harness, not a field to auto-fill." Dockhand routes them to the WhatsApp Approve button.
- State: `previous_response_id` + `store: true` (simplest, but 3-4x slower live; Dockhand uses stateless). Stateless (`store:false`) replay holds up to 29 call/output pairs and needs `meta_safety_replay_receipt` copied.
- Loop ends when a response has no `computer_call`. `max_output_tokens` hit → `status: "incomplete"`. Reference sample caps at 50 steps.
- The guide's system prompt guidance: batch only steps that don't need fresh visual feedback, wait on loads, never claim completion without on-screen proof, declare infeasible tasks.
- `truncation:"auto"`: docs contradict (guide says "where enabled", API ref says unsupported). Don't send it.
- The same page documents a code-execution alternative (model writes Playwright through a function tool), "best when the steps are known ahead of time". This is the official endorsement of compile-to-replay.

## Other models
- Muse Wonder: "Frontier coding, long-running agents, and advanced computer use." Preview. Use for teach. **Live, it refuses the computer tool** (see Verified live), so repair runs on Spark.
- Muse Image: `/v1/images/generations` and `/v1/images/edits`. No real job in Dockhand.
- SAM 3.1: noun phrase → boxes/masks, video tracking. No real job in Dockhand.
- Muse Code: terminal coding agent (`irm https://dev.meta.ai/install.ps1 | iex`), build-time only.
- Open weights: Muse Spark Open, Muse Glimmer. Baseten tag: `meta-models/muse-spark-open` (verified 2026-10-28 with GET /v1/models on Baseten; the participant guide's `-1026` suffix is not in the catalog).

## Verified live (2026-10-28)

First live runs against api.meta.ai and Baseten with our keys. Raw evidence: `scripts/live/*`, recorded responses in `fixtures/cassettes`, per-call ledger rows (`var/agent-live`, not committed).

### Confirmed as documented
- Structured output: Responses `text.format` `{type: "json_schema", name, schema, strict: false}` returns schema-conforming JSON (keys come back sorted). Our wire schema (every key required, optional ones nullable) is accepted as is.
- Files API: `POST /v1/files` (multipart, `purpose=user_data`) returns `{id: "file-…", status: "uploaded", expires_at: null}`. PDFs and mp4 work as `input_file` by `file_id`.
- Video: the 45 s 1280×800 teach mp4 costs ~10.4k input tokens (~230 tokens/s). Muse Wonder, effort medium: 20 s, $0.09, draft graded clean.
- Voice Transcribe: response `{sessionId, transcript, audioDurationMs, turns[{turnId, startMs, endMs, transcript}]}` (no `speaker`). `audioDurationMs` was 13760 for a WAV whose header says 13712 ms.
- Computer use on muse-spark-1.3: coordinates are pixels of the last 1280×800 screenshot (every first-run click hit the element under the point). Keys come as `["PageDown"]`, `["ctrl","a"]`, `["Alt","Left"]`, `["Tab"]`. A user `input_text` note right after `computer_call_output` is accepted and followed. Echoing safety checks in `acknowledged_safety_checks` is accepted. Assistant messages with `phase: "commentary"` come before the `computer_call`.
- Usage: `input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens` are present; prompt caching hits on stateless requests too.

### Differs from the docs or from what we assumed
| What | Seen live | What Dockhand does now |
|---|---|---|
| No `reasoning` field | Runs at effort **high**; with `max_output_tokens` 200-300 the response is `incomplete` (`max_output_tokens`) with ~all tokens spent on reasoning | Effort per purpose (`packages/meta/src/policy.ts`); budget never below the effort's floor (low 4096, medium 8192); one retry with a doubled budget |
| `muse-wonder-1.0` + computer tool | HTTP 400 `Unsupported tool type: 'computer'` (also rejects `computer_use`, `computer_use_preview`); the computer-use page says it runs on Wonder | Computer-use sessions fall back to muse-spark-1.3 on that error (logged, ledger shows the real model) |
| `pending_safety_checks` | **Every** acting `computer_call` carries `{code: "computer_action_requires_confirmation", message: "Review and confirm before executing this computer action."}`, even a scroll on a neutral page; a screenshot-only call carries none | That code is acknowledged by harness policy (plan approval, commit guard, write guard); any other code still goes to the rep |
| `scroll_x` / `scroll_y` units | Wheel notches: "scroll about half a screen" → `scroll_y: 4`. Occasionally pixels (`-800`) | Deltas under 50 are notches × 100 px; larger ones are pixels |
| `previous_response_id` chain | 9-11 s per turn vs 2.4-3.2 s for the same turn sent stateless; latency grows with chain length (up to ~21 s at 20 images) | Stateless replay (`store: false`, receipts kept, reasoning items dropped), last ≤12 turns (window drops back to 6) |
| Off-screen targets | Asked to propose a submit button below the fold, Spark answered y=862 on an 800 px screenshot | Points outside the screenshot are refused with a note (no clamping); `propose_target` must hit a button or link |
| Latency tail | One computer-use turn in ~190 took 108 s (p99 ~21 s) | A turn slower than 40 s is resent once when the deadline allows |
| Smooth scrolling | A screenshot right after PageDown showed the page mid-scroll; the model then clicked labels for several turns | Screenshots and keypresses wait for scrolling to stop |
| Spark Open on Baseten | Tag `meta-models/muse-spark-open`; `response_format` `json_schema` and `json_object` both accepted (schema not enforced); low effort reasons 120-390 tokens; 1-8 s per call | Same floor as Meta (rung 2's 400-token budget ended `length` on 2 of 8 calls); our zod validation stays the real check |
| Screenshot after a function call | A user `input_image` after the first turn: HTTP 400 "native computer input images are supported only in the initial request" (hit after `attach_file`) | The function output says the screen changed; the model's next `screenshot` action returns the image |
| Trimmed stateless history | When the first replayed turn after the opening message answered a function call: HTTP 400 "Invalid or missing computer safety acknowledgement" (2 of 2 supplier runs, ~75 actions in). Trims that start on a computer call were accepted | The window only cuts where a turn opens with a computer call |
| Hung requests | On the supplier wizard one turn request hung twice until the 90 s deadline | 30 s per attempt, one resend, then MODEL_TIMEOUT; the loop starts a fresh conversation from its own summary (twice per run at most) and reports "waiting for the model (N s)" every 10 s meanwhile |
| 50-image cap | Not reached: the stateless window keeps requests at ≤13 images | Rollover code kept for chained mode |

### Results (Standard list prices)

The first live runs, each with the fixes it led to. Where a later measurement exists, it supersedes these rows: the heal numbers in [`evals/results/live-headline.md`](../../evals/results/live-headline.md) (Oct 28, after these fixes) have `combobox_to_radio` at 6/6.
| Job | Model, effort | Live result |
|---|---|---|
| Understand (voice text, photo, PDF) | Spark, low | All graded fields right except `buyerName` from the Acme PDF ("Laura Bennett", want "Acme Group": prompt issue); 3-5 s, ~$0.005 |
| Extract photo / PDF | Spark, low | Every handwritten value found; 6 s / 9-11 s; ~$0.01. Minimal effort also matched on the photo at 2.3 s |
| Teach from video | Wonder, medium | All grading checks pass; 20 s, $0.09. Country enum lists only the 7 options visible in the video; consent came back as a required boolean param |
| Transcribe | voice-transcribe-1.0 | 13.7 s synthetic note in 3.3 s, $0.0006 |
| First run, Caravela v1 (13 fields) | Spark, low | Before fixes 0/1 (60-action budget, 554 s, $0.38). After: **3/3**, 13/13 fields each, 29-31 actions, 14-20 calls, 0 rollovers, $0.105-0.196, 74-116 s. Commit gate rejected: 0 submissions |
| First run | Wonder | 0/2: HTTP 400 on the computer tool |
| First run, supplier wizard (Acme, 40 fields, 2 uploads, zero-shot) | Spark, low | Before fixes 0/4 (user image after attach_file: 400; a hung turn; safety-ack 400 twice). After: **3/3**, 40/40 fields each, 85-98 actions, 39-50 calls, 0 rollovers, $0.32-0.49, 249-310 s, slowest turn 21 s |
| Compile + Globex replay | annotate on Spark, low | One compile failed its 2 dry runs (a Next click that hit validation was compiled before the checkbox) and would not be saved; the other passed 2/2 and replayed on Globex at 40/40 fields, 0 model calls, 4.8 s. Annotating the 54-step skill needed > 4096 output tokens |
| Rung 2 heal_match | Spark Open, low | button_rename 4/4 healed; combobox_to_radio 0/4 and v2 product widget 0/2 declined or rejected (role change), never a wrong submit; ~3 s, ~$0.002 per call |
| Rung 3 cu_repair (≤8 actions) | Spark, low | After the off-screen fix: button_rename 2/2 (propose_only), v2 1/2 (other hit the 90 s budget on the 108 s turn); combobox_to_radio 0/2 ("the repair did not enter product") |
| Full ladder, repair suite (6 cases) | rungs 2+3 | 4/6: v2 2/2, button_rename 2/2, combobox_to_radio 0/2 (safe stop); $0.002-0.026 per case |
