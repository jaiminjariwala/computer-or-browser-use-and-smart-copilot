/**
 * voice-lib — Glass on-device voice dictation component library (v1).
 *
 * This is the frozen, known-good baseline for speech-to-text. Consume it from
 * the app via this barrel; do not edit these files when experimenting with new
 * approaches — add a new module/version instead so the working flow can't be
 * regressed. See README.md.
 */
export { useDictation } from './useDictation'
export type { Dictation, DictationOptions } from './useDictation'
export { useSmoothDictation } from './useSmoothDictation'
export type { SmoothDictationOptions } from './useSmoothDictation'
export { VoiceBars, AnimatedTranscript } from './VoiceUI'
