/**
 * voice-lib — shared voice UI.
 *
 * The v1 dictation engine (Whisper tiny on WASM via @xenova/transformers)
 * that used to live here was removed once every window moved to the
 * voice-lib-v2 engine (Whisper base on WebGPU); shipping two transformers
 * stacks doubled the bundled ONNX runtime for no benefit. Only the shared
 * mic glyph remains.
 */
export { VoiceBars } from './VoiceUI'
