# voice-lib — on-device voice dictation (v1, frozen baseline)

A self-contained component library for speech-to-text in Click. This is the
**known-good baseline**. It works smoothly and fast; treat it as frozen.

## Rule

**Do not edit these files when trying new/faster approaches.** In the race to
build something nicer we kept regressing the working flow. To prevent that:

- Keep this `v1` working as-is.
- For experiments, create a sibling module (e.g. `useStreamingDictation.ts`) or a
  `voice-lib-v2/` folder, and switch the app import to try it.
- Only promote an experiment to the default once it clearly beats v1; keep v1
  importable for instant rollback.

## What's inside

| File | Purpose |
| --- | --- |
| `asr.worker.ts` | Dedicated Web Worker running Whisper (`Xenova/whisper-tiny.en`) via transformers.js, off the UI thread. Serializes jobs; strips `[BLANK_AUDIO]`/`(music)` artifacts. Built as a classic IIFE worker so it loads under Electron `file://`. |
| `useDictation.ts` | Records the mic (Web Audio), downsamples to 16 kHz, runs interim passes (~450ms) + an instant first pass (~160ms), and emits raw transcript text. Appends to existing text across mic on/off. Stop is instant (no late pass unless nothing was captured yet). |
| `useSmoothDictation.ts` | Wraps `useDictation` with a character-by-character reveal buffer so text streams in smoothly (no jumpiness from batch re-transcription). The shipping composer uses this. |
| `VoiceUI.tsx` | `VoiceBars` (animated equalizer mic glyph) and `AnimatedTranscript` (per-word fade reveal — optional/experimental). |
| `index.ts` | Barrel exports. |

## Behavior contract (v1)

- **Worker, not main thread** — inference never blocks the UI.
- **Stable height** — the composer keeps one always-mounted `<textarea>`; the
  reveal writes into it. No element swapping (that caused height collapse).
- **Smooth, fast** — first word ~immediately; continuous character reveal.
- **Append, don't overwrite** — toggling mic continues from current text.
- **Instant stop** — no transcript change lands after you stop.

## Requirements / environment

- Needs mic permission (entitlement + `NSMicrophoneUsageDescription`) and a
  relaxed CSP (`script-src 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
  `connect-src https:`, `worker-src blob:`) so the worker can load the WASM and
  fetch the model. The model (~40 MB) downloads once from the Hugging Face CDN
  and is cached.
- Styling for `glass-voicebars*` / `glass-transcript*` is provided by the app's
  stylesheet, not bundled here.

## Usage

```ts
import { useSmoothDictation, VoiceBars } from '../voice-lib'

const dictation = useSmoothDictation({
  getText: () => draftRef.current,   // current field text
  setText: setDraft,                 // write revealed text
  onError: (msg) => showError(msg)
})

// mic button:
<button onClick={dictation.toggle} disabled={dictation.transcribing}>
  <VoiceBars active={dictation.listening} />
</button>

// keep the field read-only while listening so the reveal isn't fought:
<textarea readOnly={dictation.listening} value={draft} ... />
```
