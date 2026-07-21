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
| ~~`voice-lib` (v1)~~ (engine removed) | Whisper tiny.en | WASM (CPU), @xenova v2 | first known-good baseline; engine deleted once every window ran v2 — shipping two transformers stacks doubled the bundled ONNX runtime (~25 MB). The folder now holds only the shared `VoiceBars` glyph. |
| **`voice-lib-v2`** (current) | **Whisper base.en** | **WebGPU → WASM, @huggingface v3** | **the single engine, used by the sidebar AND the capture overlay** |
| ~~`voice-lib-v3`~~ (removed) | Moonshine base | WebGPU → WASM | was faster, but hallucinated words too often to trust — deleted |

Why Whisper base won: Moonshine was quicker on short clips, but it invented
words the user never said. For dictation, a wrong transcript is worse than a
slow one, so the reliable engine is the only one shipped — and the in-composer
V1/V2 engine picker is gone; the mic is just a mic now.

**Rule: never edit an existing version to experiment** — add a new
`voice-lib-vN` folder and switch the import. See
`src/renderer/voice-lib/README.md`.

### File map

```
renderer/voice-lib/            (shared UI only — engine removed)
├─ VoiceUI.tsx (VoiceBars, CSS-animated)   index.ts

renderer/voice-lib-v2/         (current — Whisper base / WebGPU)
├─ asr.worker.ts               # Whisper, WebGPU → falls back to WASM
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
