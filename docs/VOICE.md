# Voice dictation

Speak instead of type. Everything runs **on-device** — no audio is uploaded.

## Why it's built this way

- The browser SpeechRecognition API doesn't work in Electron, and the AI gateway
  has no audio endpoint. So we run **Whisper** locally via transformers.js.
- Whisper is heavy → it runs in a **dedicated Web Worker** so the UI never freezes.
- Whisper answers in bursts → we **ease** the text in character-by-character so it
  looks smooth instead of jumping.

## End-to-end flow

```
  ┌───────────┐   ┌───────────────┐   ┌──────────────────────────┐   ┌──────────────┐
  │  Tap mic  │ ->│  Web Audio    │ ->│   Worker (Whisper)       │ ->│  transcript  │
  │           │   │  capture PCM  │   │   transformers.js        │   │  text        │
  │           │   │  → 16kHz mono │   │   (off the UI thread)    │   │              │
  └───────────┘   └───────────────┘   └────────────┬─────────────┘   └─────┬────────┘
                         ▲                         │ posts {id,audio}      │
                         │   poll every ~0.3–0.45s │ gets {id,text}        ▼
                         └─────────────────────────┘              ┌────────────────────────┐
                          (re-transcribes audio-so-far)           │  Smooth reveal buffer  │
                                                                  │  visible text catches  │
                                                                  │  up to the latest      │
                                                                  │  transcript            │
                                                                  └────────────────────────┘
```

Key behaviors:
- **Instant first word** — a first pass fires ~120–160ms after you start.
- **Append, don't overwrite** — toggling the mic continues from current text.
- **Instant stop** — no late transcript lands after you stop (a final pass runs
  only if nothing was captured yet, e.g. a one-word utterance).
- **Clean text** — Whisper's `[BLANK_AUDIO]` / `(music)` artifacts are stripped.

## Three versions (a component library)

Each version is frozen in its own folder, so experiments can't regress a
known-good flow. The app imports exactly one; rolling back is a one-line change.

| Version | Model | Backend | Notes |
| --- | --- | --- | --- |
| `voice-lib` (v1) | Whisper tiny.en | WASM (CPU), @xenova v2 | first known-good baseline |
| `voice-lib-v2` | Whisper base.en | WebGPU → WASM, @huggingface v3 | faster + more accurate |
| **`voice-lib-v3`** (current) | **Moonshine base** | **WebGPU → WASM, @huggingface v3** | **fastest + precise for real-time; no 30s padding** |

Why Moonshine (v3): it's an encoder-decoder ASR model built for real-time, using
rotary position embeddings so it handles variable-length audio without Whisper's
fixed 30s window — our short interim clips transcribe much faster, and it beats
Whisper-tiny on accuracy.

Switching versions is a one-line import change in `src/renderer/sidebar/App.tsx`:
`../voice-lib-v3` ⇄ `../voice-lib-v2` ⇄ `../voice-lib`. **Rule: never edit an
existing version to experiment** — add a new one. See
`src/renderer/voice-lib/README.md`.

### File map

```
renderer/voice-lib/            (v1, frozen — Whisper tiny / WASM)
├─ asr.worker.ts   useDictation.ts   useSmoothDictation.ts   VoiceUI.tsx   index.ts

renderer/voice-lib-v2/         (frozen — Whisper base / WebGPU)
├─ asr.worker.ts   useSmoothDictation.ts   index.ts

renderer/voice-lib-v3/         (current — Moonshine base / WebGPU)
├─ asr.worker.ts               # Moonshine, WebGPU → falls back to WASM
├─ useSmoothDictation.ts       # capture + worker + reveal + cancel, self-contained
└─ index.ts
```

`<VoiceBars>` (the animated mic glyph) is shared from `voice-lib` regardless of
which engine version is active.

## Environment requirements

- **Mic permission**: entitlement `com.apple.security.device.audio-input` +
  `NSMicrophoneUsageDescription`; a `setPermissionRequestHandler` grants `media`.
- **CSP** (in the renderer HTML) is relaxed enough for the local model:
  - `script-src 'unsafe-eval' 'wasm-unsafe-eval' blob:` (run the WASM/WebGPU runtime)
  - `connect-src https:` (download the model from the Hugging Face CDN)
  - `worker-src blob:` (spawn the worker)
- **Worker format**: built as a **classic IIFE** worker (not ESM), because the
  app loads over `file://` where module-worker scripts fail Chromium's MIME check.
- **Model download**: fetched once from the HF CDN (~40MB tiny / larger for base),
  then cached; offline afterward.

## Tuning knobs

| What | Where | Note |
| --- | --- | --- |
| interim poll interval | `INTERIM_MS` | v1 ~450ms, v2 ~300ms |
| first-pass delay | `setTimeout(... )` in `start()` | ~120–160ms |
| reveal speed | `revealMs` + step in `useSmoothDictation` | ~16ms tick |
| model | `MODEL` in the worker | tiny.en (fast) vs base.en (accurate) |
