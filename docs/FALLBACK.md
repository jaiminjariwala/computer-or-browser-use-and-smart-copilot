# Fallback chain

Smart Copilot and the operator can run on your own OpenAI-compatible endpoints,
free hosted keys, and local on-device models. If one provider fails, the app
tries the next provider until one answers.

## The chain

```text
  1. Primary provider      your OpenAI-compatible endpoint             [main]
  2. Local fallback        optional Ollama or similar local gateway    [main]
  3. Free hosted chain     Gemini -> Zhipu GLM -> OpenRouter           [main]
                           each key is optional and stored encrypted
  4. On-device SmolVLM     transformers.js, WebGPU/WASM                [renderer]
                           no key, no network after model download
```

Tiers 1-3 use the same OpenAI-compatible client surface. Tier 4 runs in the
renderer because it uses transformers.js in a worker.

## Request flow

```text
  renderer sends message/screenshot
        |
        v
  main: ChatFlow.complete() -> ai.ts runWithFallback()
        |                         |
        |                         | try each configured network provider
        |                         v
        |                  all network providers failed
        v                         |
  append assistant turn           v
                         main emits chat:fallback (+ context)
                                   |
                                   v
                         renderer runs SmolVLM locally
                                   |
                                   v
                         chat:fallback-result (text|null)
```

The request stays pending while the chain runs, including while the on-device
model downloads or generates.

## On-device tier

- Model: `HuggingFaceTB/SmolVLM-256M-Instruct`, falling back to
  `SmolVLM-500M-Instruct` if needed.
- Runtime: transformers.js, WebGPU first and WASM if WebGPU is unavailable.
- First use downloads the model once, then it is cached and works offline.

Files:

- `src/renderer/sidebar/local-vlm.worker.ts`
- `src/renderer/sidebar/localFallback.ts`

## Configuring free hosted providers

Open Settings -> "Free fallback models (optional)" and paste any of:

| Provider | Where to get a free key | Default model |
| --- | --- | --- |
| Google Gemini | aistudio.google.com/apikey | `gemini-2.5-flash` |
| Zhipu GLM | open.bigmodel.cn | `glm-4v-flash` |
| OpenRouter | openrouter.ai/keys | `openrouter/free` |

Only providers with a stored key are tried. Keys are encrypted via the OS
keychain and never written to `config.json`.
