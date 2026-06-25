/**
 * voice-lib-v2 — WebGPU-accelerated dictation (experimental, faster).
 *
 * Drop-in replacement for v1's useSmoothDictation. Uses transformers.js v3 with
 * the WebGPU backend (whisper-base.en) when available, falling back to WASM
 * (whisper-tiny.en). Reuses v1's VoiceBars for the mic glyph.
 *
 * If this ever misbehaves, switch the app import back to `../voice-lib` (v1).
 */
export { useSmoothDictation } from './useSmoothDictation'
export type { Dictation, SmoothDictationOptions } from './useSmoothDictation'
