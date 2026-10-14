# Reasoning display

FoxFleet shows an agent's thinking as a collapsed block above its reply (web and Android). Settings > **Show reasoning** turns it off per device.

## Where it comes from
| Source | What the hub reads |
|---|---|
| Native Hermes chat | `reasoning.delta` (streamed), `reasoning.available` (only if nothing streamed), `message.complete.reasoning` (fallback). `thinking.delta` is the spinner text and is dropped. |
| Hermes chat API (HTTP runs; the field depends on the model provider, e.g. OpenRouter, Z.ai / GLM, DeepSeek) | `reasoning_content`, `reasoning`, `reasoning_text`, `thinking` on deltas or messages |
| Models that write it into the text | `<think>...</think>` and `<thinking>...</thinking>`, also when a tag is split between chunks |

All of these leave the hub as `reasoning_content`; the reply text never contains it. History keeps it, so old chats show it. Tool progress is separate.

Shared cases: `contract/reasoning.vectors.json` (hub: `server/test/reasoning.test.js`, web: `web/tests/reasoning.test.tsx`, Android: `Batch6ScreenshotTest`).
