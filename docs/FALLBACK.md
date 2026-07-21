# Chat fallback chain

Smart Copilot keeps answering by walking a deliberately short provider chain:
your own endpoint first, then free hosted keys. If one provider fails, the
next takes over on the same request.

```
  1. Your own endpoint     corporate gateway / paid / local server     [main]
                           (any OpenAI-compatible URL + model + key)
  2. Free hosted keys      OpenRouter -> Google Gemini                 [main]
                           (each skipped unless its key is saved)
```

Each hosted provider gets one immediate retry before the chain moves on
(free tiers occasionally drop a response mid-body). Whichever tier answers
first wins; the rest are never called.

## When everything fails

Two different situations get two different outcomes:

- **Nothing is configured at all** (fresh install): the chat shows an inline
  setup card where the user pastes a free Gemini or OpenRouter key directly —
  no Settings hunt. Company/personal endpoints link to the full Settings form.
- **Keys exist but nothing answered** (outage, bad key, offline): the origin
  chat gets a short error turn — "None of your connected AI providers could
  answer. Check your keys in Settings and try again."

The request stays pending while the chain runs and settles when a tier
answers, the failure turn lands, or the user cancels that question.

## Free hosted providers

| Provider | Get a key at | Default model |
| --- | --- | --- |
| OpenRouter | openrouter.ai/settings/keys | `openrouter/free` (auto-picks a live free model) |
| Google Gemini | aistudio.google.com/app/apikey | `gemini-2.5-flash` |

Keys are encrypted with the macOS keychain (`openrouter-key.enc`,
`gemini-key.enc`) and never stored in plain text. Requests to hosted providers
include the screenshots/frames you send — that's inherent to using a hosted
model.

## What was removed (history)

Earlier versions carried two more tiers: a user-configured "fallback gateway"
(typically local Ollama) and an on-device SmolVLM model that answered when
every network tier failed. Both were cut deliberately: the extra Settings
fields confused far more users than they served, and the on-device model
added a large one-time download for weak answers. Voice dictation still runs
on-device (see [Voice](./VOICE.md)); chat requires one working provider.

Source: `src/main/ai.ts` (`runWithFallback`), `src/main/config.ts`
(`HOSTED_FALLBACKS`), `src/renderer/sidebar/SetupCard.tsx`.
