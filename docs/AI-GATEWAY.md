# AI gateway & models

This app speaks the standard **OpenAI-compatible** chat format, so it can point
at your own models without code changes: configure a base URL, a model id, and
an API key when that provider needs one.

## Request path

If one tier fails, the next tier is tried. The final fallback runs locally.

```text
  Click app (image + question + memory)
        |
        v
  1. Primary OpenAI-compatible provider
        | fails / not set
        v
  2. Optional local gateway, such as Ollama
        | fails / not set
        v
  3. Free hosted chain, keyed once in Settings:
        Google Gemini -> Zhipu GLM -> OpenRouter
        | all fail / no keys
        v
  4. On-device SmolVLM
        no key, local renderer worker
```

- **Primary + hosted providers** live in the main process. `ai.ts` builds the
  chat request and `runWithFallback()` tries each configured provider in order.
- **On-device fallback** runs in the renderer. When every network provider
  fails, the main process emits `chat:fallback`; the renderer runs SmolVLM and
  returns `chat:fallback-result`.

## Settings

`Settings` stores non-secret config in `config.json`; keys are encrypted with
Electron `safeStorage` and kept out of the JSON file.

- **Primary**: any OpenAI-compatible base URL, model, and optional key.
- **Fallback gateway**: usually local Ollama at `http://localhost:11434/v1`.
- **Free hosted models**: Google Gemini, Zhipu GLM, and OpenRouter. Paste a key
  once and that provider joins the chain automatically.

Default hosted models:

| Provider | Default model |
| --- | --- |
| Gemini | `gemini-2.5-flash` |
| GLM | `glm-4v-flash` |
| OpenRouter | `openrouter/free` |

Hosted providers receive screenshots you send through them. The on-device tier
keeps screenshots local.

## Choosing a model

Use a vision-capable chat model for screenshots and PDFs. For the operator,
choose a provider/model that supports tool or function calling.
