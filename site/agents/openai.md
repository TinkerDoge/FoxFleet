# OpenAI-compatible

For anything that implements `POST {base}/chat/completions` with streaming: self-hosted gateways, vLLM, LM Studio, Ollama's OpenAI endpoint, a GLM proxy, an OpenCode server…

| Field | Notes |
| --- | --- |
| Base URL (**required**, write-only) | The API root including its version path, **ending before** `/chat/completions`, e.g. `https://api.example.com/v1`. `http://` and `https://` are accepted; no credentials, query or fragment. |
| Model (**required**) | Sent as `model` in each request. |
| API key (optional, write-only) | Sent as `Authorization: Bearer …` if present. Local servers often need none. |

**Capabilities:** chat and images (as OpenAI `image_url` parts). No files, sessions, screen or voice.

**Test connection** calls `GET {base}/models` and expects `{ "data": [...] }` (*Models listed*). If your server has no `/models` route the test fails although chat may still work.

The hub follows no redirects when calling the provider. A request that hits the 10 MiB chat limit is refused with `413`.

::: tip Running a model on the hub's own machine
Use the loopback or LAN address as base URL. Because the hub makes the call, the phone never needs to reach it.
:::
