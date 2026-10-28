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
- State: `previous_response_id` + `store: true` (simplest). Stateless (`store:false`) replay holds up to 29 call/output pairs and needs `meta_safety_replay_receipt` copied.
- Loop ends when a response has no `computer_call`. `max_output_tokens` hit → `status: "incomplete"`. Reference sample caps at 50 steps.
- The guide's system prompt guidance: batch only steps that don't need fresh visual feedback, wait on loads, never claim completion without on-screen proof, declare infeasible tasks.
- `truncation:"auto"`: docs contradict (guide says "where enabled", API ref says unsupported). Don't send it.
- The same page documents a code-execution alternative (model writes Playwright through a function tool), "best when the steps are known ahead of time". This is the official endorsement of compile-to-replay.

## Other models
- Muse Wonder: "Frontier coding, long-running agents, and advanced computer use." Preview. Use for teach and repair.
- Muse Image: `/v1/images/generations` and `/v1/images/edits`. No real job in Dockhand.
- SAM 3.1: noun phrase → boxes/masks, video tracking. No real job in Dockhand.
- Muse Code: terminal coding agent (`irm https://dev.meta.ai/install.ps1 | iex`), build-time only.
- Open weights: Muse Spark Open, Muse Glimmer. Baseten tag: `meta-models/muse-spark-open` (verified 2026-10-28 with GET /v1/models on Baseten; the participant guide's `-1026` suffix is not in the catalog).
