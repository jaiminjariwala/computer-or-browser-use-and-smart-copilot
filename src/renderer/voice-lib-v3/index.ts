/**
 * voice-lib-v3 — Moonshine (WebGPU) dictation. Fastest + most precise for
 * short real-time clips. Drop-in replacement for v2's useSmoothDictation.
 *
 * Rollback: switch the app import to `../voice-lib-v2` (Whisper base / WebGPU)
 * or `../voice-lib` (Whisper tiny / WASM, v1).
 */
export { useSmoothDictation } from './useSmoothDictation'
export type { Dictation, SmoothDictationOptions } from './useSmoothDictation'
