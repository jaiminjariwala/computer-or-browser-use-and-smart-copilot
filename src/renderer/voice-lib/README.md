# voice-lib — shared voice UI

Only the shared `VoiceBars` mic glyph (CSS-animated equalizer) lives here now.

The v1 dictation engine (Whisper tiny on WASM via `@xenova/transformers`) that
this folder originally held was removed once every window — sidebar and
capture overlay — moved to the `voice-lib-v2` engine (Whisper base on WebGPU
via `@huggingface/transformers`). Shipping two transformers stacks doubled the
bundled ONNX runtime for no user benefit.

## Rule for future voice experiments

Never edit `voice-lib-v2` in place. Add a sibling `voice-lib-vN` folder,
switch the app's import to try it, and delete the loser. Frozen versions are
how the working flow stays regression-proof (see docs/VOICE.md for the full
version history, including why v3/Moonshine was dropped).
