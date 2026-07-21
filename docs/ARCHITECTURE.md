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
│  ├─ github-auth.ts     # GitHub Device Flow + safeStorage token store (main only)
│  └─ operator/          # autonomous operator engine (self-contained)
│     ├─ evals/          # deterministic AgentLoop scenarios, scoring, JSON CLI
│     ├─ main/           # loop, safety, environments, executor, providers ...
│     │  ├─ bootstrap/   # services + start gate + IPC wiring
│     │  ├─ loop/        # perceive -> reason -> act state machine + progress checks
│     │  ├─ safety/      # fail-closed gate, autonomy, kill-switch controller
│     │  ├─ environment/ # local Mac + Playwright browser + container backends
│     │  ├─ executor/    # native + cliclick input backends
│     │  ├─ providers/   # OpenAI-compatible providers + tolerant parser
│     │  ├─ perception/  # capture + observation
│     │  ├─ memory.ts    # bounded, sanitized completed-session recall
│     │  ├─ session*/    # operator session model + store (isolated)
│     │  ├─ config*/     # operator provider config (isolated file)
│     │  ├─ windows/     # indicator overlay + optional noVNC window
│     │  └─ ipc.ts       # op:* channels (namespaced, no collisions)
│     └─ shared/         # operator types, resolved via the @op-shared alias
├─ preload/index.ts      # typed window.glass and window.operator bridges
├─ renderer/
│  ├─ sidebar/           # shared chat shell + separate mode conversations
│  │  ├─ App.tsx         # composer, captures, operator controls
│  │  ├─ ChatSidebar.tsx # history rail: chats, mode toggle, GitHub account, Settings
│  │  ├─ VideoRecorder.tsx # getUserMedia/MediaRecorder camera recording dialog
│  │  ├─ video.ts        # extractVideoFrames: local video -> bounded JPEG frames
│  │  ├─ privacy.ts      # shared secret/identifier detection + redaction
│  │  ├─ operator.ts     # privacy-aware operator activity explanations
│  │  ├─ pdf.ts          # rasterizes attached PDFs to images (pdfjs)
│  │  ├─ SetupCard.tsx    # in-chat key setup card (first-run, no provider)
│  │  └─ Settings.tsx    # provider and fallback configuration
│  ├─ overlay/           # capture surface
│  ├─ indicator/         # agent-in-control overlay + Emergency Stop
│  ├─ voice-lib/         # shared voice UI
│  └─ voice-lib-v2/      # Whisper dictation engine (the only one)
└─ shared/types.ts       # Smart Copilot types
```

Two path aliases keep the type worlds apart: `@shared/*` for Smart Copilot and
`@op-shared/*` for the operator.

## Operator evaluation architecture

The standalone `npm run eval:operator` command loads the same `AgentLoop` and
in-memory `SessionManager` used by the app. It replaces only the four injected
side-effect boundaries—perception, reasoning, safety, and execution—with
scripted collaborators and supplies deterministic clocks and IDs.

```
  scripted perception ─┐
  scripted reasoning ──┼──► real AgentLoop ─► real SessionManager ─► JSON report
  scripted safety ─────┤
  scripted executor ───┘
```

No Electron process, browser, API key, network request, application-session
persistence, or real input action is used while the AgentLoop runs. After the
suite finishes, the CLI writes only its deterministic JSON evaluation report.
This makes terminal-state, retry, budget, confirmation, token, cost, duration,
and efficiency results repeatable while still testing the production orchestration
code.

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

Every capture stages into the composer carousel — the overlay has no input of
its own; the question is typed (or dictated) in the one composer. Staged shots
(and images/PDFs added via the paperclip button, PDFs rasterized by `pdf.ts`)
are sent together on Send via `chat:send-captures` as one multi-image message.

## Video attachment pipeline

Videos join the same carousel as screenshots, but they are converted into a
bounded image sequence entirely inside the sidebar renderer before anything is
sent. The raw video file never crosses IPC and never reaches a provider.

```
 upload (paperclip → Files / drag&drop)  record (paperclip → Camera)
   mp4 / m4v / mov / webm / ogv            getUserMedia + MediaRecorder
              │                            (camera-only retry if mic denied)
              └────────────┬───────────────┘
                           ▼
              staged carousel card: playable <video> preview
              + "Sampling frames…" while extraction runs
                           │
                           ▼
              extractVideoFrames() in sidebar/video.ts
              ├─ recover duration (MediaRecorder WebM files often
              │  omit it; a far seek reveals the real end time)
              ├─ pick ≤ 12 timestamps (~1 per 4s, skewed off the
              │  frequently-blank first/last samples)
              ├─ seek + draw each frame to a canvas, downscaled so
              │  the longest edge is ≤ 1280px
              └─ encode JPEG data URLs -> TurnCapture[] where each
                 carries videoFrame { sequenceId, index/count,
                 timestampSeconds, durationSeconds }
                           │
                           ▼  Send (blocked with a tooltip while extracting)
              chat:send-captures  — the same channel screenshots use
                           │
                           ▼
              main ai.ts captureParts(): each frame becomes a text
              label ("Video sequence <id>, frame i/n at m:ss …")
              followed by a normal image_url part, so any vision
              model reads the frames as one chronological video
```

Because frames reuse the existing `chat:send-captures` path, video support
required no new IPC channel, no provider-side video API, and no change to the
session model: a video is just a user turn whose `captures` include ordered
`videoFrame` metadata.

## Reasoning fallback chain

`ai.complete` no longer just tries one gateway. It runs a short chain — your
own OpenAI-compatible endpoint, then the free hosted keys (OpenRouter ->
Gemini). If everything fails, main decides the outcome: nothing configured at
all -> the sidebar shows an in-chat key setup card (`setup:needed`); keys exist
but unreachable -> a short error turn lands in the origin chat. See
[Fallback chain](./FALLBACK.md).

## Window behavior

A single-instance lock ensures only one instance runs (a second launch just
focuses the existing window). The desktop window opens wide enough for a
persistent 296px chat rail plus the conversation canvas; below the responsive
breakpoint the rail becomes an overlay. The window is normal by default, and a
header pin toggle (`window:set-pinned`) floats it on top when you want.

The chat rail synthesizes the active in-memory session alongside archived
history, so the selected title and live progress never disappear merely because
`current.json` is excluded from archive listings. Its footer owns Settings and
GitHub account controls.

GitHub authentication uses OAuth Device Flow in `github-auth.ts`. Only a public
client id is configured. Device/access-token exchange, profile lookup, and
`safeStorage` encryption stay in main; preload exposes only non-secret status,
challenge code/URL, and minimal identity.

## IPC channel map (preload bridge)

| Direction | Channel | Purpose |
| --- | --- | --- |
| SB → main | `chat:send` | send a typed message |
| SB → main | `chat:send-captures` | send staged screenshots/images as one message |
| SB → main | `capture:trigger` | begin a region capture |
| overlay → main | `capture:region` / `capture:cancel` | rectangle chosen / cancelled |
| SB → main | `session:new/get/list/open/delete` | conversation management |
| SB → main | `models:list` | list gateway models |
| SB → main | `config:get-status` / `config:save` | provider settings + keys |
| SB → main | `window:set-pinned` | pin/unpin the window on top |
| SB → main | `github-auth:status/start/logout` | non-secret status, begin Device Flow, or remove the encrypted token |
| main → SB | `github-auth:changed` | non-secret sign-in lifecycle and minimal identity |
| main → SB | `turn:appended`, `request:pending`, `error:show`, `session:state`, `summary:state`, `credentials:required` | live UI updates |
| main → SB | `capture:staged` | a captured shot to add to the carousel |
| main → SB | `setup:needed` | no provider configured — show the in-chat key setup card |

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
- The sidebar CSP additionally allows `media-src 'self' blob:` so the staged
  video preview card can play a local blob URL; no remote media source is
  allowed.
- A Chromium permission request handler in `index.ts` grants only the `media`
  permission, and only to the trusted sidebar `webContents`; every other
  permission and every other renderer is denied.
- Screen Recording is a runtime macOS permission (TCC), not an entitlement.
- Microphone uses an entitlement + `NSMicrophoneUsageDescription`; the usage
  string also covers audio in videos you record in-app.
- Camera recording uses the `com.apple.security.device.camera` entitlement +
  `NSCameraUsageDescription` (asked the first time you open the recorder).
- GitHub access tokens are encrypted with `safeStorage` in the main process
  (`github-token.enc`) and never cross the preload bridge; the renderer sees
  only non-secret status, the short user code, the verification URL, and
  minimal identity.
