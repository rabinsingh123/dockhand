# Integration facts (researched 2026-10-27)

Companion to `meta-api-notes.md` (Meta Model API facts are not repeated here).

Conventions:
- Text in quotes is verbatim from the cited page (tabs in tables shown as `|`).
- **UNVERIFIED** = could not confirm in an official source.
- **Ours:** = our reading or recommendation, not something the source says.

---

## 1. Open-weight models: Muse Spark Open and Muse Glimmer

### 1.1 Spec summary

| | Muse Spark Open | Muse Glimmer |
|---|---|---|
| Size | 816B total, 42B active (sparse MoE) | 30B dense (Fireworks lists 29.7B) |
| Input | text, image, audio, video | text, image |
| Output | text | text |
| Context | 1,048,576 tokens | 128K default ("131,072" native per llama.cpp guide) |
| License | Muse Model License (+ Usage Policy) | Apache 2.0 |
| Reasoning | always on; `low`/`medium`/`high`/`xhigh` (default `xhigh`) | always on; `low`..`xhigh` (llama.cpp template default `high`) |

Sources:
- https://dev.meta.ai/docs/muse-spark-open: "Muse Spark Open | 816B total, 42B active | Sparse mixture of experts, multimodal (text, image, audio, and video input; text output) | 1,048,576 tokens". "Muse Spark Open is released under the Muse Model License. Use is also subject to the Acceptable Use Policy."
- https://dev.meta.ai/docs/muse-glimmer: "Muse Glimmer is Meta's 30-billion-parameter open-source multimodal model, distilled from Muse Spark and built for local agentic workflows." "Muse Glimmer | 30B | Dense, multimodal (text + image input; text output) | 128K tokens by default; longer contexts supported". "Muse Glimmer weights are released under the Apache License 2.0."
- https://dev.meta.ai/docs/muse-spark-open/settings: "low | 8 | Classification, extraction, straightforward questions, and short tool loops" ... "xhigh | 512 (default)". "Stop on <|eot|> and the end-of-text token only."
- https://dev.meta.ai/docs/muse-spark-open/prompting: "Reasoning can't be turned off. Any value other than these four, such as none or max, is rejected."
- https://dev.meta.ai/docs/muse-glimmer/deploy (llama.cpp): "The chat template reads reasoning_strength and defaults to high". "Use reasoning_strength, not reasoning_effort ... reasoning_effort, the OpenAI spelling, is not implemented by llama.cpp."

### 1.2 Image input: which deployments actually accept images

- Spark Open on Baseten: yes. https://docs.baseten.co/inference/model-apis/vision: "Muse Spark Open accepts JPEG, PNG, WebP, GIF, BMP, and TIFF images."
- Spark Open on Fireworks: yes. https://dev.meta.ai/docs/muse-spark-open/deploy: "The model accepts text and images, supports tool calling, and has a context window of 1,048,576 tokens."
- Glimmer: only some builds. https://dev.meta.ai/docs/muse-glimmer/deploy (SGLang): "The bf16 checkpoint is the only one that takes images." and "GGUF, NVFP4, and MLX are text only." But llama.cpp serves GGUF with a vision projector: "The vision projector downloads with the text model, so image input needs no extra flag."
- Glimmer on Modal: **text only**. https://modal.com/docs/guide/supported-models (Dedicated Endpoint models): "Muse Glimmer 30B BF16 | Text" and "Muse Glimmer 30B NVFP4 | Text".
- Glimmer on Ollama: vision listed. https://ollama.com/library/muse-glimmer capabilities "vision tools thinking", tag `muse-glimmer:30b` "18GB", "128K context window".

### 1.3 Structured output / JSON schema

- **Spark Open on Baseten does NOT enforce schemas.** https://docs.baseten.co/inference/model-apis/overview: "All Model APIs support tool calling. All except Muse Spark Open support structured outputs and JSON mode." https://docs.baseten.co/inference/structured-outputs: "Model APIs support structured outputs except for Muse Spark Open, which accepts `json_schema` but doesn't enforce the schema."
- Spark Open on Fireworks: JSON mode only is documented. https://dev.meta.ai/docs/muse-spark-open/deploy: "Streaming (stream=True) and JSON mode (response_format={"type": "json_object"}) work the same way they do for other Fireworks chat models." `json_schema` for this model: **UNVERIFIED** (Fireworks supports `json_schema` generally per https://docs.fireworks.ai/structured-responses/structured-response-formatting, model-specific support not stated).
- Spark Open on Groq (access needs approval): https://dev.meta.ai/docs/muse-spark-open/deploy: "On GroqCloud the model has a 131,072-token context window and supports tool calling, structured outputs, and image input."
- Glimmer self-hosted on vLLM: enforced. https://github.com/meta-models/meta-oss-cookbook/tree/main/muse-glimmer/recipes/structured-output: "schema enforced by the server" and "The server constrains decoding. Invalid JSON is not a failure mode you handle". Recipe banner: "Max VRAM observed | ~60 GB (bf16, batch 1)". Note the recipe sets `temperature=0.0`, while the deploy guide says "Don't run this model greedy." (conflicting guidance).
- Meta's own Spark Open / Glimmer docs have no structured-output section (checked prompting + settings pages).
- Ours: on Baseten, treat Spark Open output as untrusted text. Ask for JSON in the prompt, validate with zod, retry once on failure.

### 1.4 Calling Muse Spark Open on Baseten

Facts:
- Base URL and slug. https://dev.meta.ai/docs/muse-spark-open/deploy (Baseten): model string `meta-models/muse-spark-open`; "The endpoint is OpenAI-compatible. Point any OpenAI client at Baseten" with `base_url="https://inference.baseten.co/v1"`.
- **Verified 2026-10-28:** Baseten `GET /v1/models` lists `meta-models/muse-spark-open` (text+image input; tools, json_mode, reasoning; no structured_outputs; $1.25/M in, $4.25/M out). A `meta-models/muse-spark-open-1026` tag is not in the catalog, in Baseten docs or on the model page. The catalog needs a key: `curl https://inference.baseten.co/v1/models -H "Authorization: Bearer $BASETEN_API_KEY"` (an unauthenticated call returns 401).
- Auth. https://docs.baseten.co/organization/api-keys: "Pass your API key in the `Authorization` header using the `Bearer` scheme" ... "Baseten also accepts the legacy `Api-Key` scheme on every endpoint".
- Limits (Baseten model table, https://docs.baseten.co/inference/model-apis/overview): "Muse Spark Open | meta-models/muse-spark-open | 1048k | 1048k" (context, max output).
- Media limits for Spark Open (https://docs.baseten.co/inference/model-apis/vision): "Max images per request | ... | 8"; "Max size per image (URL) | ... | 10 MB"; "Max request body (base64) | ... | 100 MiB"; "Max video duration | ... | 300 seconds". "Muse Spark Open doesn't accept PDF files. Extract their text before sending it." Image URLs must be reachable from Baseten: "Baseten retrieves image URLs from the inference service".
- Audio (https://docs.baseten.co/inference/model-apis/audio): "WAV, MP3, FLAC, OGG (Vorbis or Opus), or M4A/AAC; 8–48 kHz; ... up to 4 files, 25 MB and 5 minutes each".
- Reasoning (https://docs.baseten.co/inference/model-apis/reasoning): "Muse Spark Open | `low`, `medium`, `high`, `xhigh` (default) | `none` and `minimal` run at `low`".
- Quirks (overview): "Muse Spark Open accepts `logprobs` and `top_logprobs` but ignores them ... `n` greater than 1 returns HTTP 400. Neither `seed` nor `temperature: 0` guarantees reproducible output."
- APIs: Chat Completions `/v1/chat/completions`, Responses `/v1/responses` ("it serves requests statelessly: send the full conversation as `input` on every call"), Anthropic Messages beta.
- Rate limits (https://docs.baseten.co/inference/model-apis/pricing-and-limits): "Basic (unverified) | 15 | 100,000", "Basic (verified) | 120 | 500,000", "Pro | 120 | 1,000,000" (RPM | TPM).
- Price (https://www.baseten.co/library/muse-spark-open, via fetch): input $1.25, cached $0.15, output $4.25 per 1M tokens.

Documented request (Meta docs, verbatim):
```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["BASETEN_API_KEY"],
    base_url="https://inference.baseten.co/v1",
)

response = client.chat.completions.create(
    model="meta-models/muse-spark-open",
    messages=[{"role": "user", "content": "Explain what a stack trace is in two sentences."}],
)
print(response.choices[0].message.content)
```

Ours: Dockhand replay-verification request assembled from the documented fields above (the catalog model string, verified 2026-10-28):
```bash
curl https://inference.baseten.co/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BASETEN_API_KEY" \
  -d '{
    "model": "meta-models/muse-spark-open",
    "reasoning_effort": "low",
    "max_tokens": 4096,
    "messages": [{"role": "user", "content": [
      {"type": "text", "text": "Read the confirmation on this screen. Reply with JSON only: {\"success\": boolean, \"registration_id\": string or null}"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,<SCREENSHOT>"}}
    ]}]
  }'
```

### 1.5 Fireworks (Spark Open)

https://dev.meta.ai/docs/muse-spark-open/deploy (Fireworks), verbatim:
```bash
curl https://api.fireworks.ai/inference/v1/chat/completions \
  -H "Authorization: Bearer $FIREWORKS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "accounts/fireworks/models/muse-spark-open",
    "messages": [{"role": "user", "content": "Explain mixture-of-experts models in two sentences."}],
    "max_tokens": 4096
  }'
```
- "Images. Pass image URLs or base64 data URLs in the message content."
- "Thinking cannot be turned off, so reasoning_effort="none" is rejected."
- Model page https://fireworks.ai/models/fireworks/muse-spark-open (via fetch): "Available on serverless on US-only capacity", $1.25 / $0.15 / $4.25 per 1M, context "1040k tokens".

### 1.6 Modal (Spark Open)

- https://modal.com/docs/guide/supported-models (Shared Endpoint models): "Muse Spark Open | Text, Image, Audio | 1.25 / 0.15 cached | 4.25".
- https://modal.com/docs/guide/endpoints: "Shared Endpoints always require a Proxy Token." "Join the token ID and secret with a period (.) and pass them as a bearer token: Authorization: Bearer wk-<id>.ws-<secret>". "Set model to the value shown in the dashboard's request examples."
```bash
curl "<your-endpoint-url>/v1/chat/completions" \
  -H "Authorization: Bearer $MODAL_PROXY_TOKEN_ID.$MODAL_PROXY_TOKEN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-name>",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```
- Endpoint URL and model name come from the dashboard ("Once the Endpoint is ready, the dashboard provides its URL, model name, and request examples." https://modal.com/docs/guide/shared-endpoints). Model string likely `meta-models/Muse-Spark-Open-816B-A42B` (appears in Modal library link only): **UNVERIFIED**.
- Billing catch, https://modal.com/docs/guide/shared-endpoints: "Credits included with your plan cannot be used for Shared Endpoint usage."

### 1.7 Where Glimmer can run on partner hardware

- Meta lists only one hosted provider for Glimmer: https://dev.meta.ai/docs/muse-glimmer/deploy: "Together AI | meta-models/Muse-Glimmer-30B" ($0.35 in / $1.50 out per 1M; "Long requests end at 32,768 output tokens").
- Fireworks: serverless deprecated. https://fireworks.ai/models/fireworks/muse-glimmer-30b: "Is Muse Glimmer 30B being deprecated on Fireworks? Only on serverless, starting on September 25, 2026. On-demand deployment will continue to be available." Page also shows "Serverless | Not Supported", "Supporting image input | Supported".
- Modal: Dedicated Endpoint only, text only (see 1.2).
- Baseten: Glimmer is not in the Model APIs table; a dedicated vLLM deploy would be needed. **UNVERIFIED** whether Baseten has a Glimmer library entry.
- Ours: Spark Open on a hosted serverless API is the cheapest way to run the open weights. Glimmer on partner hardware means paying for dedicated GPUs, and on Modal it loses vision.

### 1.8 Can Glimmer run on this laptop?

This machine (read via `Get-CimInstance`, 2026-10-27): ASUS Zenbook S 16 UM5606WA, AMD Ryzen AI 9 365, Radeon 880M integrated GPU, 23.1 GB usable RAM (shared with the iGPU), no NVIDIA GPU.

What the docs require:
- https://dev.meta.ai/docs/muse-glimmer/quantization: "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf | 16.8 GB", "mmproj-Muse-Glimmer-30B-Q4_K_M.gguf | 1.4 GB | Vision projector, required for image input." "K-Quant-17GB with the vision projector and a full 131,072-token context measures 19 GiB of VRAM". "That fits a 24 GiB card with headroom."
- LM Studio note (deploy page): "Q4_K_M measured about 24.1 GiB at one request and 16K context, so leave room for the OS and Bionic."
- bf16 / Transformers: "The bf16 weights are around 60 GB and need about 72 GB of VRAM to serve".
- llama.cpp: "Muse Glimmer needs llama.cpp b10353 or newer." Ollama: "Muse Glimmer requires Ollama 0.32.7 or later". ExecuTorch: "No CPU export; use llama.cpp".
- Spark Open locally is out of reach: Unsloth table "2-bit | 300-315 GB".

Ours: not realistic for the demo. A 17 to 19 GB model on a 23 GB shared-memory machine leaves no room for Windows, Chrome/Playwright and Node, and an iGPU is memory-bandwidth bound (our estimate: a few tokens per second, so a reasoning reply plus a screenshot would take minutes). Smaller Unsloth quants exist (`unsloth/Muse-Glimmer-30B-GGUF`, "Dynamic quants from UD-IQ2_XXS through UD-Q8_K_XL"); their sizes and quality are **UNVERIFIED**. Ollama/llama.cpp GPU acceleration on the Radeon 880M under Windows: **UNVERIFIED**.

### 1.9 License and usage-policy obligations

- Spark Open license, https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md: "Licensee shall prominently display "Built with Muse Spark Open" in the user interface of each product or service that uses the Software or any Derivatives, or in the accompanying documentation, website, or settings menu." The $20M revenue clause applies only to "Model as a Service" and "does not apply to ... the Licensee's use of the Software as a component to power features of the Licensee's own product".
- Usage Policy (same file) prohibits, among others: "Representing that the use of Muse Spark Open or outputs are human generated".
- Glimmer: Apache 2.0, no attribution line required beyond Apache terms.
- Ours: put "Built with Muse Spark Open" in the README and in the receipt footer. Keep Spark Open out of drafting buyer-facing replies that a rep sends as their own words.

### 1.10 Glimmer computer-use note

https://github.com/meta-models/meta-oss-cookbook/tree/main/muse-glimmer/recipes/computer-use-web: "Status: not verified on this checkpoint." and "Coordinates are normalized 0-1000, origin top-left". This differs from Meta Model API's native computer tool (pixel coordinates, see meta-api-notes.md).

---

## 2. Meta Model API: PDFs and images

PDF input to `muse-spark-1.3`: supported, inline or via Files API.
- https://dev.meta.ai/docs/file-handling: "Include bytes inline in a single Responses API or chat completion request, or upload once with the Files API and reuse the ID across calls. Both paths work for images, video, and PDFs."
- Supported document type: "Document | application/pdf | Converted to text plus per-page images."
- Size: "Inline (file_data base64 or file_url in the request body) | 50 MB (50,000,000 bytes)"; "Files API upload (POST /v1/files) | 1 GiB (1,073,741,824 bytes)".
- PDF handling: "Text is extracted from the first 100 pages; pages beyond 100 contribute no text." "Only the first 50 page-images are retained for visual understanding. These page-images count toward the per-request image budget (up to 50 images per request".
- Shapes: Responses uses "an input_file content block carrying file_data (with an optional filename), or a file_url the server fetches for you"; Chat Completions uses "a file content block whose nested file object carries file_data (base64 bytes, optionally as a data: URL) and a filename". Uploaded files are referenced with `{"type": "input_file", "file_id": "file-..."}`.
- Responses example (verbatim, trimmed to the content block):
```python
{
    "type": "input_file",
    "filename": "document.pdf",
    "file_data": file_data,   # "data:application/pdf;base64,..."
},
```
- Storage: "Uploaded files also count toward a per-team total storage limit of 100 GiB". "Uploaded files don't expire". Optional `expires_after` with `seconds` "from 3600 (1 hour) to 2592000 (30 days)".

Images for `input_image` (https://dev.meta.ai/docs/image-understanding):
- "Supported MIME types | image/jpeg, image/jpg, image/png, image/gif, image/webp, image/x-icon"
- "Max file size per image (inline image_url) | 50 MB (50,000,000 bytes)"
- "Max file size per image (input_file via Files API) | 1 GiB (1,073,741,824 bytes)"
- "Max images per request | 50, enforced. More than 50 returns HTTP 400."
- "Undecodable images return 400".
- No max pixel dimension is stated; "the model may resize images".

Side note: file-handling also lists "Audio | audio/mpeg, audio/wav | MP3 and WAV audio input" and video as "Visual frames plus embedded-audio transcription". meta-api-notes.md recorded from the video page that audio understanding "is currently not fully supported". The two pages read differently; keep the Voice Transcribe path.

---

## 3. WhatsApp Cloud API

Docs moved to `developers.facebook.com/documentation/business-messaging/whatsapp/...`; any page is readable as Markdown by appending `.md`.

### 3.1 Graph API version

https://developers.facebook.com/docs/graph-api/changelog/: "The latest Graph API version is: v26.0" ("v26.0 | July 29, 2026 | TBD"; v25.0 available until July 29, 2028). WhatsApp reference pages use `v26.0` in examples. Base: `https://graph.facebook.com/v26.0/`.

### 3.2 Webhooks

Verification (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint):
- GET: `?hub.mode=subscribe&hub.challenge=<HUB.CHALLENGE>&hub.verify_token=<HUB.VERIFY_TOKEN>`. "If the request is valid, respond with HTTP status 200 and the hub.challenge value."
- POST header: `X-Hub-Signature-256: sha256=<SHA256_PAYLOAD_HASH>`, where the hash is "HMAC-SHA256 hash, calculated using the post body payload and your app secret as the secret key." Validation: "Generate an HMAC-SHA256 hash using the JSON payload as the message input and your app secret as the secret key." "Compare your generated hash to the hash assigned to the X-Hub-Signature-256 header (everything after sha256=)." Ours: hash the raw body bytes before JSON parsing; compare in constant time.
- "POST requests are aggregated and sent in a batch with a maximum of 1000 updates." "If any POST request sent to your server fails, delivery is retried immediately, then a few more times with decreasing frequency over the next 7 days. Your server should handle deduplication in these cases."
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview: "Webhook payloads can be up to 3 MB." Troubleshooting: "Make sure your app is in Live mode; some webhooks will not be sent if your app is in Dev mode."
- https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput: "Median latency not to exceed 250ms." "Less than 1% latency exceeds 1s."
- Permissions: "whatsapp_business_messaging — for messages and calls webhooks".

Full envelope, text message (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text):
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1749416383",
                "type": "text",
                "text": {
                  "body": "Does it come in another color?"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

Forwarded flags (syntax block, text reference):
```
<!-- only if message forwarded to business by a user -->
"context": {
  "forwarded": true,            <!-- only included if forwarded 5 times or less -->
  "frequently_forwarded": true  <!-- only included if forwarded more than 5 times -->
},
```
The same block appears in the image and video references. It does **not** appear in the audio or document syntax blocks (`.../messages/audio`, `.../messages/document`). Whether forwarded voice notes and PDFs carry `context.forwarded`: **UNVERIFIED**. Ours: never gate behavior on the forwarded flag.

`messages[0]` for the other types (verbatim examples from each reference page):

Audio / voice note (`.../webhooks/reference/messages/audio`):
```json
{
  "from": "16505551234",
  "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
  "timestamp": "1744344496",
  "type": "audio",
  "audio": {
    "mime_type": "audio/ogg; codecs=opus",
    "sha256": "wvqXMe6n7n1W0zphvLPoLj+s/NtKqmr3zZ7YzTP7xFI=",
    "id": "1908647269898587",
    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...",
    "voice": true
  }
}
```
`voice`: "Boolean indicating if audio is a recording made with the WhatsApp client voice recording feature (true) or not (false)."

Image (`.../messages/image`):
```json
{
  "from": "16505551234",
  "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
  "timestamp": "1744344496",
  "type": "image",
  "image": {
    "caption": "Taj Mahal",
    "mime_type": "image/jpeg",
    "sha256": "SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=",
    "id": "1003383421387256",
    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
  }
}
```

Document (`.../messages/document`):
```json
{
  "from": "16505551234",
  "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
  "timestamp": "1744344496",
  "type": "document",
  "document": {
    "caption": "my receipt",
    "filename": "receipt.pdf",
    "mime_type": "application/pdf",
    "sha256": "V5OPpLD/gEG6Xjg0MbmQDLFgcKsL+j5LfY4ny/pZ4MY=",
    "id": "622684793477189",
    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
  }
}
```

Video (`.../messages/video`):
```json
{
  "from": "16505551234",
  "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
  "timestamp": "1744344496",
  "type": "video",
  "video": {
    "caption": "Timelapse of growth",
    "mime_type": "video/mp4",
    "sha256": "vdGU5X4caz12KwFgYwpljlUNqMt1YnkH+5GkPc3mMnc=",
    "id": "731675419373506",
    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
  }
}
```

Interactive button reply (`.../messages/interactive`):
```json
{
  "context": {
    "from": "15550783881",
    "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MEM2RUJFNkI0RENGQTVDRjUA"
  },
  "from": "16505551234",
  "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTZBQzg0MzQ4QjRCM0NGNkVGOAA=",
  "timestamp": "1750025136",
  "type": "interactive",
  "interactive": {
    "type": "button_reply",
    "button_reply": {
      "id": "cancel-button",
      "title": "Cancel"
    }
  }
}
```
`context.id` is the "WhatsApp message ID of the message containing the button the WhatsApp user tapped." List replies use `"type": "list_reply"` with `list_reply: {id, title, description}`.

The `url` field on media webhooks: "This JSON property is being released to developers gradually over several weeks, starting November 12, 2025, and may not be available to you immediately." Ours: use `url` when present, otherwise `GET /{media-id}`.

### 3.3 Media

https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
- Get URL: `curl 'https://graph.facebook.com/<API_VERSION>/<MEDIA_ID>?phone_number_id=<BUSINESS_PHONE_NUMBER_ID>' -H 'Authorization: Bearer EAAJB'` returns `{"messaging_product","url","mime_type","sha256","file_size","id"}`. "Media URLs expire after 5 minutes, after which you must query the ID again to get a new URL."
- Download: `curl '<MEDIA_URL>' -H 'Authorization: Bearer EAAJB...' -o '<DESIRED_FILE_NAME>'`. "If you omit your token, the request will fail." On `404`, "try to get a new media URL and download it again."
- ID lifetimes: "Media IDs returned by the API expire after 30 days. Media IDs in webhooks expire after 7 days."
- Upload: 
```
curl 'https://graph.facebook.com/<API_VERSION>/<PHONE_NUMBER_ID>/media' \
-H 'Authorization: Bearer <ACCESS_TOKEN>' \
-F 'messaging_product=whatsapp' \
-F 'file=@<FILE_PATH_AND_NAME>;type=<MIME_TYPE>'
```
  Response `{"id": "<MEDIA_ID>"}`.
- Send by ID (https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/image-messages): `"type": "image", "image": {"id": "<MEDIA_ID>", "caption": "<MEDIA_CAPTION_TEXT>"}`; caption "Maximum 1024 characters."

Size limits and MIME types (outbound/upload table on the media page):

| Type | MIME | Max |
|---|---|---|
| Audio | audio/aac, audio/amr, audio/mpeg, audio/mp4, audio/ogg ("OPUS codecs only; base audio/ogg not supported; mono input only") | 16 MB |
| Document | text/plain, xls, xlsx, doc, docx, ppt, pptx, application/pdf | 100 MB |
| Image | image/jpeg, image/png ("Images must be 8-bit, RGB or RGBA.") | 5 MB |
| Sticker | image/webp | 500 KB animated, 100 KB static |
| Video | video/3gpp, video/mp4 ("Only H.264 video codec and AAC audio codec supported.") | 16 MB |

Inbound limit is different: "The maximum supported file size for media messages on Cloud API is 100MB. In the event the customer sends a file that is greater than 100MB, you will receive a webhook with error code 131052". Ours: the 16 MB video cap only matters for videos we send; teach recordings up to 100 MB can come in. Anything over 50 MB must go to Meta's Files API (see section 2). A screen recording sent as a file arrives as `type: "document"` with a video MIME (ours, **UNVERIFIED**), and Meta video input is mp4 only, so transcode `.mov`.

### 3.4 Interactive messages

Reply buttons (https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages):
- "send up to three predefined replies"
- Button ID: "Maximum 256 characters."
- Button label: "Must be unique if using multiple buttons. Maximum 20 characters."
- Body: "Maximum 1024 characters."
- Footer: "Maximum 60 characters."
- Header types: "document", "image", "text", "video". Text-header max length is not stated on this page: **UNVERIFIED** (list messages state 60).
```json
"action": {
  "buttons": [
    {
      "type": "reply",
      "reply": {
        "id": "<BUTTON_ID>",
        "title": "<BUTTON_LABEL_TEXT>"
      }
    }
  ]
}
```

List messages (https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages): "up to 10 sections, with up to 10 rows for all sections combined". Button text "Maximum 20 characters"; body "Maximum 4096 characters"; header "Supports text header type only. Maximum 60 characters"; footer "Maximum 60 characters"; row ID "Maximum 200 characters"; row title "Maximum 24 characters"; row description "Maximum 72 characters"; section title "Maximum 24 characters".

### 3.5 Mark as read and typing indicator

https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/mark-message-as-read:
```json
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "<WHATSAPP_MESSAGE_ID>"
}
```
POST to `/<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages`. "When you mark a message as read, the API also marks earlier messages in the conversation as read."

https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators: same body plus `"typing_indicator": {"type": "text"}`. "The typing indicator will be dismissed once you respond, or after 25 seconds, whichever comes first." Ours: for long runs send a short "working on it" text; re-sending the indicator for the same message is **UNVERIFIED**.

### 3.6 Setup: test number, permanent token, webhook subscription

- Test number: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers: "When you complete the steps in the Get Started document, a test business phone number is generated and registered for you automatically." Recipient cap: current docs do not state it. Older docs and third parties say 5 verified recipients: **UNVERIFIED**.
- Permanent token (https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started, Step 5):
  1. "Navigate to Business Settings and click System users in the sidebar."
  2. "Click the Add+ button in the upper-right corner and follow the prompts to create a new system user."
  3. "Select the new system user you created, and click Assign Assets." "Select your app and toggle Manage app under Full control." "Select your WhatsApp account and toggle Manage WhatsApp Business accounts under Full control."
  4. "Click Generate token." Permissions: `business_management`, `whatsapp_business_messaging`, `whatsapp_business_management`.
  - https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens: in the token dialog "choose a token expiration preference". Employee system users need access to "both accounts the system user needs to work with: the WhatsApp account and the Messaging account. Access to the Messaging account alone is not sufficient." Missing access returns "error code 200".
- Webhook subscription (create-webhook-endpoint page): "navigate to the App Dashboard > WhatsApp > Configuration panel, and add your webhook endpoint URL to the Callback URL field, and your verification string to Verify token field." For apps made with the WhatsApp use case: "navigate to App Dashboard > Use cases > Customize > Configuration instead." "If your webhook endpoint is responding to webhook verification GET requests properly, the panel will save your changes, and a list of fields you can subscribe to will appear." Subscribe `messages`. TLS: "Self-signed certificates are not supported."

### 3.7 Pricing change that affects the demo (effective Oct 1, 2026)

https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing:
- "Each business phone number has one free tier of 1,000 delivered service messages per month. Meta charges as of the 1,001st service message per month, after the free tier has been used."
- "If businesses do not have a payment method for their Messaging account(s), Meta will deliver service messages within the free tier but not deliver them after the free tier has been used."
- Whether this applies to the test number: **UNVERIFIED**.
- Ours: keep the 50-run evals off WhatsApp (call the runner directly), or add a payment method.

### 3.8 WhatsApp terms: AI Providers clause

`https://www.whatsapp.com/legal/business-solution-terms/` now redirects to https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform ("Last Modified: September 23, 2026"). Section 4.7, verbatim:

> "4.7 AI Providers. Providers and developers of artificial intelligence or machine learning technologies, including but not limited to large language models, generative artificial intelligence platforms, general-purpose artificial intelligence assistants, or similar technologies as determined by Meta in its sole discretion ("AI Providers"), are strictly prohibited from accessing or using the WhatsApp Business Platform, whether directly or indirectly, for the purposes of providing, delivering, offering, selling, or otherwise making available such technologies when such technologies are the primary (rather than incidental or ancillary) functionality being made available for use, as determined by Meta in its sole discretion; provided, however, that such technologies may be made available to businesses in certain countries as set forth here. Notwithstanding the foregoing, you may retain an AI Provider as your Solution Provider. In such cases, you may not directly or indirectly allow WhatsApp Business Platform Data, including any anonymous, aggregate, or derived forms of WhatsApp Business Platform Data, to be used to create, develop, train, or improve any machine learning or artificial intelligence systems, models, or technologies, including large language models (collectively, "AI Models"); provided that you may use WhatsApp Business Platform Data to fine-tune an AI Model that is for your exclusive use, so long as this does not result in WhatsApp Business Platform Data being used to create, develop, train, or improve any other AI Models. This Section survives termination of these Terms."

Effective date per https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers: "Effective January 15, 2026, WhatsApp's Terms of Service update "AI Providers" are only permitted to offer general-purpose AI assistants on the WhatsApp Business Platform where Meta is legally required to permit this use case." Brazil (+55) is listed as a market where AI Providers may send service messages, charged per message since March 11, 2026. Charged AI-provider traffic shows `"category": "general_purpose_ai"` in status webhooks.

What is allowed: the ban targets AI being "the primary (rather than incidental or ancillary) functionality". The source does not define where a business workflow agent falls; Meta decides "in its sole discretion".

Ours, risk read for Dockhand:
- Supports the position: the product is a sales workflow (CRM writes, portal registration) for the business's own reps; the AI is the means, not the product offered.
- Risks: (1) any open-ended Q&A makes it look like a general-purpose assistant; (2) sending WhatsApp-received content to `muse-spark-1.3-contributor` (Meta may train on it) runs against the data sentence; (3) "as determined by Meta in its sole discretion".
- Mitigations: fixed intent set, refuse off-task chat, synthetic data only, never route WhatsApp-derived media or text to contributor mode, watch status webhooks for `general_purpose_ai`.

Messaging policy (https://whatsappbusiness.com/policy/, "Last updated: September 23, 2026", fragments via fetch): "You may use automation when responding during the 24-hour window" and automated experiences "must also have available prompt, clear, and direct escalation paths". Ours: add a "talk to a person" path even for internal reps.

### 3.9 Meta's WhatsApp Business Tools MCP

It is a hosted remote server, not a GitHub repo (searched GitHub orgs `facebook` and `fbsamples`: no official repo found). Doc: https://developers.facebook.com/documentation/mcp/whatsapp-business-tools-mcp. Announcement: https://developers.facebook.com/blog/post/2026/09/15/meta-business-messaging-mcp-ai-agent/ (not opened).
- "Transport | Streamable HTTP"; "Endpoint | https://mcp.facebook.com/whatsapp_business_tools"; "Authentication | Meta developer account sign-in (OAuth)"; "Status | Beta - interface and tool set may change".
- "The WhatsApp Business Tools MCP server is rolling out gradually and may not be available to everyone yet."
- Claude Code: `claude mcp add --transport http whatsapp_business_tools https://mcp.facebook.com/whatsapp_business_tools`, then `/mcp` to authenticate. "You'll need to complete the sign-in flow again when you restart the client."
- Prerequisites: admin on the business and on "A WhatsApp-enabled app", plus "Accepted WhatsApp Business Cloud API Terms of Service".
- Tools: `whatsapp_biz_businesses`, `whatsapp_biz_accounts`, `whatsapp_biz_phone_numbers`, `whatsapp_biz_add_phone_number`, `whatsapp_biz_send_verification_code`, `whatsapp_biz_verify_phone_number`, `whatsapp_biz_register_phone_number`, `whatsapp_biz_list_templates` / `get` / `create` / `update` / `delete`, `whatsapp_biz_send_message` ("Confirms the target with you before sending"), `whatsapp_biz_configure_webhooks` ("Set the callback URL and verify token for the WhatsApp topic and subscribe the allowed fields"), `whatsapp_biz_subscribe_webhook`, `whatsapp_biz_configure_payments`, `whatsapp_biz_verify_business`, `whatsapp_biz_system_user_token` (returns a deep link; token is generated in Business Settings).

---

## 4. HubSpot API

### 4.1 Getting a test portal and token (state as of 2026-10-27)

- **Legacy private apps can no longer be created.** https://developers.hubspot.com/changelog/legacy-private-app-creation-sunset (announced Aug 27, 2026): "New HubSpot accounts (created on or after September 28, 2026): Legacy private app creation is disabled on September 28, 2026" and "Existing HubSpot accounts (created before September 28, 2026): Legacy private app creation is disabled on October 26, 2026". "All existing legacy private apps continue to work as-is." "For any new in-account API integration, use Service Keys". The docs page https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview still shows creation steps (stale).
- **Service keys** (public beta since Feb 10, 2026, https://developers.hubspot.com/changelog/service-keys): "Service Keys can be found at Settings > Integrations > Service Keys or by navigating to Development > Keys > Service Keys from the main sidebar." "Service Keys do not support webhooks." "A key can only be granted scopes the creating user already has".
- Steps (https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys): Development > Keys > Service keys > "Create service key" > name > "Add new scope" > select scopes > "Create". Use as Bearer: `--header "Authorization: Bearer pat-na1-*********-****-****-****-************"`. "Service keys are subject to the same limits as privately distributed apps". "there is a combined limit of 100 project-based apps, service keys, and MCP connectors per HubSpot account." Rotation: "Rotate and expire later ... will trigger an expiration of the key in 7 days". No automatic expiry is documented.
- Free portal for testing (https://developers.hubspot.com/docs/getting-started/account-types): "You can create up to 10 test accounts to test apps and integrations without affecting any real HubSpot data. Developer test accounts are free HubSpot accounts with access to a 90-day trial of many enterprise features". Create: "navigate to Development", "Testing > Test Accounts", "Create developer test account". "Developer test accounts will expire after 90 days if no API calls are made to the account." Legacy developer accounts: "as of March 9, 2026, all legacy developer accounts were migrated to standard HubSpot accounts." So the path is: free standard HubSpot account, then a developer test account inside it.
- Service keys inside a developer test account: **UNVERIFIED** (expected, since test accounts are HubSpot accounts where you are super admin).
- Scopes for Dockhand (https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes): `crm.objects.companies.read`, `crm.objects.companies.write`, `crm.objects.deals.read`, `crm.objects.deals.write`, `files.read`, `files.write` (or legacy `files`). The create-note endpoint accepts any of many object scopes, including `crm.objects.deals.write`.

### 4.2 API versioning

https://developers.hubspot.com/docs/developer-tooling/platform/versioning: "Starting from March 30th 2026, HubSpot's REST APIs follow a date-based version standard". "The latest API version includes a URL prefix that's formatted as /YYYY-MM (e.g., /2026-03/)." "All legacy APIs using semantic versions (e.g., v4, v3, v2, and v1) are still supported and available at their previous URLs." Current reference pages use `/2026-09/`. Base URL `https://api.hubapi.com`.

### 4.3 Endpoints

Search companies (https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm):
- `POST /crm/objects/2026-09/companies/search`. Free-text `{"query": "..."}` searches companies' default properties: "`website`, `phone`, `name`, `domain`".
- Filters in one group are AND; separate groups are OR (doc example: "first name Alice AND a last name other than Smith, OR contacts that don't have a value for the property email").
- `CONTAINS_TOKEN`: "you can use wildcards (*) to complete a partial search".
- Ours, by domain or name:
```bash
curl https://api.hubapi.com/crm/objects/2026-09/companies/search \
  --request POST \
  --header "Content-Type: application/json" \
  --header "authorization: Bearer $HUBSPOT_TOKEN" \
  --data '{
    "filterGroups": [
      {"filters": [{"propertyName": "domain", "operator": "EQ", "value": "acme.com.br"}]},
      {"filters": [{"propertyName": "name", "operator": "CONTAINS_TOKEN", "value": "acme*"}]}
    ],
    "properties": ["name", "domain"],
    "limit": 5
  }'
```
- Limits: "It may take a few moments for newly created or updated CRM objects to appear in search results." "rate limited to five requests per second per account." "maximum of five filterGroups with up to six filters in each group, with a maximum of 18 filters in total." "maximum number of supported objects per page is 200."

Create company (https://developers.hubspot.com/docs/api-reference/latest/crm/objects/companies/guide):
- `POST /crm/objects/2026-09/companies`. "include at least one of the following properties in your request: name or domain. It is recommended to always include domain, because domain names are the primary unique identifier to avoid duplicate companies in HubSpot."
```json
{
  "properties": {
    "name": "HubSpot",
    "domain": "hubspot.com",
    "city": "Cambridge",
    "industry": "Technology",
    "phone": "555-555-555",
    "state": "Massachusetts",
    "lifecyclestage": "51439524"
  }
}
```

Create deal with inline company association (https://developers.hubspot.com/docs/api-reference/latest/crm/objects/deals/guide):
- `POST /crm/objects/2026-09/deals`. "include the following properties in the request: dealname, dealstage, and if you have multiple pipelines, pipeline. If a pipeline isn't specified, the default pipeline will be used." "You must use the internal ID of a deal stage or pipeline when creating a deal via the API."
```json
{
  "properties": {
    "amount": "1500.00",
    "closedate": "2019-12-07T16:50:06.678Z",
    "dealname": "New deal",
    "pipeline": "default",
    "dealstage": "contractsent",
    "hubspot_owner_id": "910901"
  },
  "associations": [
    {
      "to": { "id": 201 },
      "types": [ { "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 5 } ]
    },
    {
      "to": { "id": 301 },
      "types": [ { "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 3 } ]
    }
  ]
}
```
(Type 5 = "Deal to primary company", 3 = "Deal to contact".)

Upload a file (https://developers.hubspot.com/docs/api-reference/latest/files/guide):
- Multipart `POST files/2026-09/files`. `folderId` or `folderPath`: "Either this field or folderPath must be provided in your request (but not both)." `options` JSON: "access, which is required, and ttl" (ttl "minimum period that must be set is 1 day", maximum "1 year").
```shell
curl --request POST \
  --url 'https://api.hubapi.com/files/2026-09/files?=' \
  --header 'Authorization: Bearer pat-na1-00000000-0000-0000-0000-000000000000' \
  --header 'Content-type: multipart/form-data' \
  --form file=@/Users/person/Downloads/cat.png \
  --form 'options={"access": "PRIVATE"}' \
  --form folderPath=/library/cat_archive
```
- "A successful 201 response will include the id and parentFolderId of the uploaded file". `access` enum (legacy v3 spec, https://developers.hubspot.com/docs/api-reference/legacy/files/files/upload-file): `HIDDEN_INDEXABLE`, `HIDDEN_NOT_INDEXABLE`, `HIDDEN_PRIVATE`, `HIDDEN_SENSITIVE`, `PRIVATE`, `PUBLIC_INDEXABLE`, `PUBLIC_NOT_INDEXABLE`, `SENSITIVE`. Legacy spec: "If a path doesn't exist, the system will try to create one."

Create a note with attachment on a deal (https://developers.hubspot.com/docs/api-reference/latest/crm/activities/notes/guide):
- `POST /crm/objects/2026-09/notes`. `hs_timestamp`: "Required." `hs_note_body`: "limited to 65,536 characters." `hs_attachment_ids`: "Multiple attachment IDs are separated by a semi-colon."
```json
{
  "properties": {
    "hs_timestamp": "2021-11-12T15:48:22Z",
    "hs_note_body": "Spoke with decision maker Carla. Attached the proposal and draft of contract.",
    "hubspot_owner_id": "14240720",
    "hs_attachment_ids": "24332474034;24332474044"
  },
  "associations": [
    {
      "to": { "id": 301 },
      "types": [ { "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 190 } ]
    },
    {
      "to": { "id": 401 },
      "types": [ { "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 214 } ]
    }
  ]
}
```
(190 = "Note to company", 214 = "Note to deal".)

Pipelines (https://developers.hubspot.com/docs/api-reference/latest/crm/pipelines/guide): "To retrieve all pipelines for an object, make a GET request to /crm/pipelines/2026-09/{objectType}." Stages: `GET /crm/pipelines/2026-09/{objectType}/{pipelineId}/stages`. Deals object type id is `0-3` (doc example `/crm/pipelines/2026-09/0-3/sales_pipeline`).
- Default pipeline ID `default` and stage `contractsent` appear in the deals guide example. The full default stage list (appointmentscheduled, qualifiedtobuy, presentationscheduled, decisionmakerboughtin, contractsent, closedwon, closedlost) is **UNVERIFIED** in current docs, and community threads report IDs vary by portal. Ours: fetch stages at startup and cache them.

### 4.4 Association type IDs (https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide)

| From → to | ID |
|---|---|
| Deal to company | 341 |
| Deal to primary company | 5 |
| Deal to contact | 3 |
| Deal to note | 213 |
| Company to deal | 342 |
| Primary company to deal | 6 |
| Note to company | 190 |
| Note to deal | 214 |
| Note to contact | 202 |

### 4.5 Rate limits (https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)

Privately distributed apps (service keys use these limits): "(Any Hub) Free and Starter | 100 / app | 250,000 / account" (per 10 seconds | per day). Professional: 190 / 625,000. Enterprise: 190 / 1,000,000. Search: 5 requests per second per account (section 4.3). 429 body includes `"errorType": "RATE_LIMIT"`.

---

## Open items to confirm

1. Baseten catalog lists `meta-models/muse-spark-open` (`GET /v1/models` with our key): verified 2026-10-28.
2. WhatsApp test-number recipient cap (old docs: 5).
3. Whether forwarded voice notes and PDFs carry `context.forwarded`.
4. Whether the Oct 1, 2026 service-message charging applies to the test number.
5. Service key creation inside a developer test account.
6. Default deal stage IDs in our portal.
