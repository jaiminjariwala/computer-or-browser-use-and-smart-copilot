# How Click works (plain language)

No jargon. Just what happens, with simple text diagrams.

For deeper technical detail see:
[Architecture](./ARCHITECTURE.md) · [Voice](./VOICE.md) · [AI gateway](./AI-GATEWAY.md)

---

## The big picture

Smart Copilot can **see a part of your screen** and tell you **what to do next**.

```
 ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
 │  Press a   │ -> │ macOS takes│ -> │ It lands as│ -> │ AI reads   │ -> │ You get    │
 │  capture   │    │ the shot   │    │ a thumbnail│    │ it + your  │    │ the next   │
 │  shortcut  │    │ (native)   │    │ over input │    │ question   │    │ step       │
 └────────────┘    └────────────┘    └────────────┘    └────────────┘    └────────────┘
        ^
        └─ you can also just TYPE a message, or SPEAK (voice → text)
```

Capture shortcuts (they use macOS's own screenshot tool, so a shot only lands
here when you press one of these):

- `⌘⇧D` — region (crosshair)
- `⌘⇧F` — a window (click to pick)
- `⌘⇧S` — the full screen

You can also drag an image onto the app or attach one with the paperclip.
(`⌘` = Command, `⇧` = Shift.)

---

## Grabbing a region of the screen

```
        ┌──────────────────────────────┐
        │  Press ⌘⇧D  (works anywhere)  │
        └───────────────┬──────────────┘
                        v
        ┌──────────────────────────────┐      No     ┌─────────────────────────────┐
        │  Screen-recording allowed?   │ ──────────> │ Show "open System Settings" │
        └───────────────┬──────────────┘             │ (nothing is captured)       │
                        │ Yes                         └─────────────────────────────┘
                        v
        ┌──────────────────────────────┐
        │  Full-screen overlay opens   │
        │  (crosshair + dimmed bg)     │
        └───────────────┬──────────────┘
                        v
        ┌──────────────────────────────┐
        │  Drag a rectangle;           │
        │  optionally type/speak a Q   │
        └───────────────┬──────────────┘
                        v
        ┌──────────────────────────────┐
        │  Overlay closes, screen is   │
        │  photographed + cropped      │
        └───────────────┬──────────────┘
                        v
        ┌──────────────────────────────┐
        │  Sent to AI → answer in chat │
        └──────────────────────────────┘
```

Neat detail: the overlay disappears **before** the photo is taken, so the dim
background and crosshair never end up in your screenshot.

---

## Speaking instead of typing

Runs fully on your Mac. No audio leaves the machine.

```
  ┌───────────┐    ┌───────────────┐    ┌────────────────────────┐    ┌──────────────┐
  │  Tap mic  │ -> │  Record mic   │ -> │   Background worker    │ -> │  Transcript  │
  │  (bars    │    │  16kHz mono   │    │   Whisper runs here    │    │  text back   │
  │  animate) │    │  audio        │    │  (off UI = no freeze)  │    │              │
  └───────────┘    └───────────────┘    └────────────────────────┘    └──────┬───────┘
                                                                              v
                                                   ┌──────────────────────────────────┐
                                                   │ Smooth reveal: text eases into    │
                                                   │ the box a few letters at a time   │
                                                   └──────────────────────────────────┘
```

It keeps re-checking every fraction of a second while you talk, so words appear
live. Full details in [Voice](./VOICE.md).

---

## Remembering your goal

Click keeps a short running summary so you never re-explain yourself.

```
  ┌───────────────┐    ┌───────────────────────────┐    ┌───────────────────────────┐
  │  You send a   │ -> │  Added to the session:    │ -> │  Sent to AI as:           │
  │  message /    │    │  • recent turns (full)    │    │  goal + done steps +      │
  │  capture      │    │  • older turns → summary  │    │  recent turns + image     │
  └───────────────┘    └─────────────┬─────────────┘    └───────────────────────────┘
                                     v
                        ┌───────────────────────────┐
                        │  Saved to disk            │
                        │  (survives restarts;      │
                        │   shows in history list)  │
                        └───────────────────────────┘
```

---

## Glossary
- **Capture** = take a picture of a part of the screen.
- **Provider** = an OpenAI-compatible endpoint or local model server that
  answers requests.
- **Worker** = a background thread so heavy work doesn't freeze the app.
- **WASM / WebGPU** = ways to run the speech model locally (CPU vs graphics chip).
- **Session / summary** = the running memory of your conversation.
