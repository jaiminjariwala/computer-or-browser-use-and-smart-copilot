# AI gateway & models

This app speaks the standard **OpenAI-compatible** chat format, so it can point
at your own models without code changes: configure a base URL, a model id, and
an API key when that provider needs one.

## Request path

If one tier fails, the next tier is tried.

```text
  Chat request (images + question + running summary)
        |
        v
  1. Your own endpoint (corporate gateway / paid / local server)
        | fails / not set
        v
  2. Free hosted keys, pasted once:
        OpenRouter -> Google Gemini
        | all fail
        v
  Nothing configured -> in-chat setup card (paste a free key right there)
  Keys exist but down -> short error turn in the origin chat
```

All providers live in the main process: `ai.ts` builds the chat request and
`runWithFallback()` tries each configured provider in order, giving hosted
providers one immediate retry for transient drops.

## Settings

Settings stores non-secret config in `config.json`; keys are encrypted with
Electron `safeStorage` and kept out of the JSON file. The form has exactly two
sections:

- **Free keys**: Google Gemini and OpenRouter. Paste a key once and that
  provider joins the chain automatically.
- **Your own AI (company or personal)**: any OpenAI-compatible base URL, model,
  and key. When set, it is always tried first.

Default hosted models:

| Provider | Default model |
| --- | --- |
| OpenRouter | `openrouter/free` |
| Gemini | `gemini-2.5-flash` |

Hosted providers receive the screenshots/frames you send through them.

## Choosing a model

Use a vision-capable chat model for screenshots and PDFs. For the operator,
choose a provider/model that supports tool or function calling.
