# Architecture

Technical overview of how Click is built. For the friendly version see
[How it works](./HOW-IT-WORKS.md).

## Electron processes & windows

Click is an Electron app: one **main** process (full system access) and
**renderer** windows (sandboxed UI) that talk to it only through a typed
**preload bridge**.

```
                  ┌──────────────────────────────┐
                  │   Main process (the brain)   │
                  │  · global hotkey (⌘⇧D)       │
                  │  · screen capture + crop     │
                  │  · AI gateway client         │
                  │  · session store (disk)      │
                  │  · macOS permission checks   │
                  └───────────────┬──────────────┘
                                  │  ipcMain.handle / webContents.send
                     ┌────────────┴────────────┐
                     │      Preload bridge     │  window.glass.* (contextIsolated)
                     └────────────┬────────────┘
                  ┌───────────────┴───────────────┐
                  v                               v
      ┌───────────────────────┐       ┌───────────────────────┐
      │    Sidebar window     │       │    Overlay window     │
      │  React chat UI        │       │  transparent, full    │
      │  · messages/markdown  │       │  screen, top-most     │
      │  · model picker       │       │  · crosshair + drag   │
      │  · voice mic          │       │  · follow-up input    │
      │  · history + settings │       │                       │
      └───────────────────────┘       └───────────────────────┘
```

The renderer never touches Node/system APIs directly — it calls
`window.glass.*`, which forwards to `ipcMain` handlers in the main process.

## Two engines in one process

The app now hosts two engines side by side in the same main process:

- The **copilot** engine (original): capture -> advise, exposed on `window.glass`.
- The **operator** engine (merged in): perceive -> reason -> act, exposed on
  `window.operator`, vendored under `src/main/operator/`.

They share the sidebar window and the user's credentials, but they are otherwise
isolated: separate IPC channel namespaces, separate config file, separate session
directory. See [Merge notes](./MERGE-NOTES.md) for how and why.

In the sidebar itself, copilot and operator each keep their own conversation and
their own history list; toggling Operator swaps which one is shown (the other is
hidden, not lost), so each mode reads like its own workspace.

```
                 ┌──────────────────────────────────────────────┐
                 │              Main process                    │
                 │                                              │
                 │   Smart Copilot             Computer/Browser │
                 │   · capture shortcuts       · agent loop     │
                 │   · capture + crop          · safety gate    │
                 │   · gateway AI client       · environments   │
                 │   · sessions/ (glass)       · operator-...   │
                 │        glass:* + chat/       · op:* channels │
                 │        session/config                        │
                 └───────────────┬──────────────────────────────┘
                                 │ ipcMain.handle / webContents.send
                    ┌────────────┴────────────┐
                    │      Preload bridge     │  window.glass + window.operator
                    └────────────┬────────────┘
              ┌──────────────────┼───────────────────┐
              ▼                  ▼                    ▼
   ┌──────────────────┐ ┌────────────────┐ ┌────────────────────┐
   │  Sidebar window  │ │ Overlay window │ │ Indicator overlay  │
   │  chat + operator │ │ region capture │ │ "agent in control" │
   │  toggle + header │ │                │ │ + Emergency Stop   │
   └──────────────────┘ └────────────────┘ └────────────────────┘
                                              (+ a separate noVNC
                                               desktop window for
                                               the sandbox browser)
```

## Source layout

```
src/
├─ main/                 # Node side (the "brain")
│  ├─ index.ts           # bootstrap: wires BOTH copilot and operator engines
│  ├─ windows.ts         # creates Sidebar / Overlay / pencil windows
│  ├─ capture.ts         # screen capture + crop to rectangle
│  ├─ capture-orchestrator.ts  # permission gate -> overlay -> capture -> AI
│  ├─ ai.ts              # OpenAI-compatible gateway client (+ fallback)
│  ├─ session.ts         # in-memory conversation + running summary
│  ├─ session-store.ts   # persistence to userData/sessions/*.json
│  ├─ summarizer.ts      # folds old turns into the summary
│  ├─ ipc.ts             # copilot ipcMain handlers + emitter helpers
│  ├─ config.ts          # gateway config + encrypted credential store
│  └─ operator/          # the merged operator engine (self-contained)
│     ├─ main/           # loop, safety, environments, executor, providers ...
│     │  ├─ bootstrap/   # services + start gate + ipc wiring
│     │  ├─ loop/        # the perceive -> reason -> act state machine
│     │  ├─ safety/      # gate, autonomy, kill-switch controller
│     │  ├─ environment/ # local (Mac) + container-desktop backends + router
│     │  ├─ executor/    # native + cliclick input backends
│     │  ├─ providers/   # OpenAI-compatible providers + tolerant parser
│     │  ├─ perception/  # capture + observation
│     │  ├─ session*/    # operator session model + store (isolated)
│     │  ├─ config*/     # operator provider config (isolated file)
│     │  ├─ windows/     # indicator overlay + noVNC desktop window
│     │  └─ ipc.ts       # op:* channels (namespaced, no collisions)
│     └─ shared/         # operator types, resolved via the @op-shared alias
├─ preload/index.ts      # the typed window.glass AND window.operator bridges
├─ renderer/
│  ├─ sidebar/           # chat UI + operator toggle/header
│  │  ├─ App.tsx         # composer, screenshot carousel, copilot+operator convos
│  │  ├─ operator.ts     # renders operator activity as chat turns
│  │  ├─ pdf.ts          # rasterizes attached PDFs to images (pdfjs)
│  │  ├─ localFallback.ts + local-vlm.worker.ts  # on-device SmolVLM fallback
│  │  └─ Settings.tsx    # gateway + free fallback provider keys
│  ├─ overlay/           # capture surface (App.tsx, selection.ts, styles.css)
│  ├─ indicator/         # "agent in control" overlay (merged from operator)
│  ├─ voice-lib/         # voice engine (VoiceBars UI; v1 STT dropped from the picker)
│  ├─ voice-lib-v2/      # voice engine shown as V1 (Whisper base, WebGPU)
│  └─ voice-lib-v3/      # voice engine shown as V2 (Moonshine, WebGPU, default)
└─ shared/types.ts       # copilot types (@shared); operator types live in operator/shared
```

Two path aliases keep the type worlds apart: `@shared/*` for the copilot types
and `@op-shared/*` for the vendored operator types.

## Capture flow (technical)

```
 renderer (sidebar)            main process                         renderer (overlay)
 ─────────────────             ─────────────                        ──────────────────
 hotkey ⌘⇧D  ───ipc──►  capture:trigger
                         └─ checkScreenPermission()
                              │ granted
                              ▼
                         WindowManager.showOverlay()  ───────────►  overlay shows
                                                                    user drags rect
                         capture:region  ◄──────ipc────────────────  submitRegion(rect,text)
                         └─ closeOverlay(); wait ~250ms (clean frame)
                         └─ CaptureService crop → base64 PNG
                         └─ route on the follow-up text:
                              ├─ text typed  → ChatFlow.handleCapture → ai.complete → turn:appended
                              └─ text empty  → capture:staged ──ipc──► carousel above the input
```

The overlay's follow-up decides the route: type a question during the drag and
it sends immediately; leave it empty and the shot is staged. Staged shots (and
images/PDFs added via the paperclip button, PDFs rasterized by `pdf.ts`) are
sent together on Send via `chat:send-captures` as one multi-image message.

## Reasoning fallback chain

`ai.complete` no longer just tries one gateway. It runs a chain (primary
OpenAI-compatible provider -> optional Ollama -> free hosted Gemini/GLM/OpenRouter),
and if all of those fail the main process hands the context to an on-device
SmolVLM model in the renderer (`chat:fallback` -> `chat:fallback-result`). See
[Fallback chain](./FALLBACK.md).

## Window behavior

A single-instance lock ensures only one instance runs (a second launch just
focuses the existing window). The window is a normal window by default; a header
pin toggle (`window:set-pinned`) floats it on top when you want.

## IPC channel map (preload bridge)

| Direction | Channel | Purpose |
| --- | --- | --- |
| SB → main | `chat:send` | send a typed message |
| SB → main | `chat:send-captures` | send staged screenshots/images as one message |
| SB → main | `capture:trigger` | begin a region capture |
| overlay → main | `capture:region` / `capture:cancel` | rectangle chosen / cancelled |
| SB → main | `session:new/get/list/open/delete` | conversation management |
| SB → main | `models:list` | list gateway models |
| SB → main | `config:get-status` / `config:save` | gateway + fallback settings |
| SB → main | `chat:fallback-result` | on-device fallback answer (or null) |
| SB → main | `window:set-pinned` | pin/unpin the window on top |
| main → SB | `turn:appended`, `request:pending`, `error:show`, `session:state`, `summary:state`, `credentials:required` | live UI updates |
| main → SB | `capture:staged` | a captured shot to add to the carousel |
| main → SB | `chat:fallback` | ask the on-device model to answer (with context) |

The operator engine adds its own `op:*` channels on a second bridge
(`window.operator`), kept separate from the copilot channels above. The full map
for both engines is in [IPC channels](./IPC-CHANNELS.md).

## Build & run

electron-vite builds three targets (main, preload, renderer); electron-builder
packages the `.app`. See [Development](./DEVELOPMENT.md).

## Security notes
- `contextIsolation` on, `nodeIntegration` off; renderer reaches main only via
  the preload bridge.
- Renderer CSP is restrictive, with a deliberate relaxation for the on-device
  speech model (WASM/WebGPU + model fetch). See [Voice](./VOICE.md).
- Screen Recording is a runtime macOS permission (TCC), not an entitlement.
- Microphone uses an entitlement + `NSMicrophoneUsageDescription`.
