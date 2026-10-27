# Documented request and response shapes

Copied from the official pages on 2026-10-27 so tests assert against documented shapes, not guesses.
"Verbatim" means the JSON block on the page with the same keys and values (whitespace is normalized by the
repo formatter). "Rendered" means a code sample (Python dict or curl body) written out as JSON with the
page's own placeholders (`<...>`) kept.

| File                                                | Source                                                                                                                                        | How                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `computer-use.tool.json`                            | https://dev.meta.ai/docs/computer-use ("Enable the computer tool")                                                                            | verbatim                        |
| `computer-use.computer_call.json`                   | https://dev.meta.ai/docs/computer-use ("Read and execute actions")                                                                            | verbatim                        |
| `computer-use.computer_call_output.json`            | https://dev.meta.ai/docs/computer-use ("Return a screenshot")                                                                                 | verbatim                        |
| `computer-use.computer_call_output.safety-ack.json` | https://dev.meta.ai/docs/computer-use ("Handle safety checks")                                                                                | verbatim                        |
| `computer-use.first-request.json`                   | https://dev.meta.ai/docs/computer-use ("Run the loop", first `responses.create`)                                                              | rendered from the Python sample |
| `computer-use.next-request.json`                    | https://dev.meta.ai/docs/computer-use ("Run the loop", chained `responses.create`)                                                            | rendered from the Python sample |
| `responses.basic-response.json`                     | https://dev.meta.ai/docs/protocols/responses ("Basic usage", example response)                                                                | verbatim                        |
| `responses.input-file-request.json`                 | https://dev.meta.ai/docs/file-handling ("Reference an uploaded file", curl)                                                                   | verbatim curl body              |
| `responses.inline-pdf-request.json`                 | https://dev.meta.ai/docs/file-handling ("In a Responses request", Python requests)                                                            | rendered                        |
| `responses.reasoning-chained-request.json`          | https://dev.meta.ai/docs/reasoning ("Multi-turn reasoning")                                                                                   | verbatim                        |
| `files.upload-response.json`                        | https://dev.meta.ai/docs/file-handling ("Upload and reference a file", example response)                                                      | verbatim                        |
| `video.input-file-request.json`                     | https://dev.meta.ai/docs/video-understanding ("Basic usage", curl)                                                                            | verbatim curl body              |
| `tool-calling.function-tool.json`                   | https://dev.meta.ai/docs/tool-calling ("Defining tools", Responses flat format)                                                               | verbatim                        |
| `tool-calling.function-call-output.json`            | https://dev.meta.ai/docs/tool-calling ("Tool calling with the Responses API", Python)                                                         | rendered                        |
| `structured-output.response-format.json`            | https://dev.meta.ai/docs/structured-output ("Using a JSON schema", `response_format` of the Address example)                                  | rendered                        |
| `speech-to-text.transcribe-request-part.json`       | https://dev.meta.ai/docs/speech-to-text ("Send the request", the curl `request` part)                                                         | verbatim                        |
| `speech-to-text.language-bias.json`                 | https://dev.meta.ai/docs/speech-to-text ("Language biasing")                                                                                  | verbatim                        |
| `speech-to-text.keywords.json`                      | https://dev.meta.ai/docs/speech-to-text ("Bias toward your own vocabulary")                                                                   | verbatim                        |
| `speech-to-text.transcribe-response.json`           | https://dev.meta.ai/docs/speech-to-text ("Read the response")                                                                                 | verbatim                        |
| `errors.rate-limit.json`                            | https://dev.meta.ai/docs/error-handling ("429 Too Many Requests")                                                                             | verbatim                        |
| `errors.validation.json`                            | https://dev.meta.ai/docs/error-handling ("Error response format")                                                                             | verbatim                        |
| `baseten.chat-completion-response.json`             | https://docs.baseten.co/inference/model-apis/reasoning ("Parse the response")                                                                 | verbatim                        |
| `baseten.openapi-components.json`                   | https://docs.baseten.co/reference/inference-api/llm-openapi-spec.json (`components.schemas`: `ResponseFormatJson`, `JsonSchema`, `UsageInfo`) | verbatim excerpt                |

Multipart requests (not JSON, so kept here as text):

- Files upload, https://dev.meta.ai/docs/file-handling: `curl -X POST "https://api.meta.ai/v1/files" -H "Authorization: Bearer $MODEL_API_KEY" -F "purpose=user_data" -F "file=@/path/to/image.png"`. The page asks for `purpose` before the file part and the file as the final part.
- Transcribe, https://dev.meta.ai/docs/api-reference/voice/transcribe: `curl -X POST "https://api.meta.ai/v1/asr/transcribe" -H "Authorization: Bearer $MODEL_API_KEY" -H "Accept: application/json" -F 'request={"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"PUSH_TO_TALK"};type=application/json' -F "audio=@recording.wav;type=audio/wav"`.

Facts from the reference pages that the code relies on (https://dev.meta.ai/docs/api-reference/responses/schemas unless noted):

- `text.format` = `{ type: "json_schema", name, schema, strict?, description? }`; `name` matches `[a-zA-Z0-9_-]{1,64}`; `strict` defaults to false and only adds schema validation against the strict subset (https://dev.meta.ai/docs/structured-output).
- `instructions`, `tools` and `reasoning.effort` are not carried across `previous_response_id`: resend them every turn (https://dev.meta.ai/docs/protocols/responses).
- `computer_call` has optional `action` and optional `actions`; `pending_safety_checks` items are `{ id, code?, message? }`.
- Usage: `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` (reasoning counted inside output).
- `max_output_tokens` minimum is 16; `truncation: "auto"` is rejected; `tool_choice` accepts only `"auto"`.
- `input_image.image_url` inline data URL: maxLength 20,971,520 characters; larger images go through the Files API.
- Function tools (Responses): flat `{ type: "function", name, description, parameters, strict? }`; names match `^[a-zA-Z0-9_.-]+$` with at most one dot; `call_id` is 1 to 64 characters.
- Transcribe request part: `model`, `audioEncoding` (`WAV` only), `mode` (`PUSH_TO_TALK` default, `ENDPOINTING`, `DIARIZATION`), `keywords`, `languageBias`. `turns` is empty in `PUSH_TO_TALK` (https://dev.meta.ai/docs/api-reference/voice/schemas).
- Retries: 429 and 503 carry `Retry-After`; 504 `gateway_timeout` should not be retried unchanged; never retry 400, 401, 402, 403, 404, 413 (https://dev.meta.ai/docs/error-handling).
