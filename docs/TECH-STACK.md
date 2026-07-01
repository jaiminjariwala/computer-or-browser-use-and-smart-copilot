# Tech stack

Every technology in the app and why it earns its place. Nothing here is
load-bearing trivia; it is the actual set of tools the code depends on.

## At a glance

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Electron (main + renderer, contextIsolated)                 │
  │                                                              │
  │   UI            React 18 + TypeScript                        │
  │   Build         electron-vite (Vite 5) + electron-builder    │
  │   Copilot AI    OpenAI-compatible gateway client             │
  │   Operator AI   OpenAI-compatible provider chain             │
  │   Fallback      free hosted chain -> on-device SmolVLM       │
  │   Voice         transformers.js (Whisper base / Moonshine)   │
  │   Docs/PDF      pdfjs-dist (attach + rasterize PDFs)         │
  │   Fonts         Inter (self-hosted, offline)                 │
  │   Sandbox       Docker (Colima) Linux desktop + noVNC        │
  │   Tests         Vitest + fast-check (property based)         │
  └─────────────────────────────────────────────────────────────┘
```

## Runtime and shell

| Tech | Role | Why this one |
| --- | --- | --- |
| **Electron 32** | Desktop shell: a privileged main process plus sandboxed renderer windows. | Gives us global hotkeys, screen capture, native input, and a Chromium UI in one runtime. |
| **electron-vite 2 / Vite 5** | Dev server and bundler for the three build targets (main, preload, renderer). | Fast HMR for the UI, auto-rebuild for main, one config for all targets. |
| **electron-builder** | Packages and signs the `.app`. | Standard, well-trodden macOS packaging. |

## UI

| Tech | Role | Why this one |
| --- | --- | --- |
| **React 18** | All renderer UI: sidebar chat, capture overlay, indicator overlay. | Component model fits the chat + panels cleanly. |
| **TypeScript 5** | The whole codebase. | Typed IPC payloads and a typed Action space catch mistakes at compile time. |
| **react-markdown + remark-gfm** | Renders assistant answers and operator step commentary as Markdown. | Assistant text is Markdown; user text stays plain. |
| **framer-motion** | Small UI motion. | Smooth, declarative transitions. |
| **@fontsource-variable/inter** | The UI font, self-hosted. | Consistent, crisp type offline and within the renderer CSP (no CDN). |
| **pdfjs-dist** | Rasterizes attached PDFs page-by-page to images. | A vision model can't read a raw PDF; the paperclip button turns each page into an image card. |

## AI

The two modes reason differently, so there are two clients.

```
  Copilot mode                       Operator mode
  ------------                       -------------
  region image + question            screenshot (+ DOM hints)
        |                                  |
        v                                  v
  OpenAI-compatible provider         OpenAI-compatible provider chain
  (chat completions, vision)         (computer-use tool calling)
        |                                  |
        v                                  v
  next-step advice text              a typed Action to execute
```

| Tech | Role | Why this one |
| --- | --- | --- |
| **openai (SDK)** | Talks to the OpenAI-compatible gateway for copilot answers and model listing, and to the whole hosted fallback chain (OpenRouter / GLM / Gemini). | They're all OpenAI-compatible, so one client serves the primary and every hosted fallback. |
| **Operator provider chain** | The operator uses the same OpenAI-compatible provider abstraction as copilot mode, including free hosted providers and local endpoints. | One provider surface keeps your own models, free hosted keys, and local gateways interchangeable. |
| **Free hosted fallback chain** | Google Gemini Flash, Zhipu GLM-4V-Flash, and OpenRouter, tried in order when the primary provider fails. | Free keyed options, and no code path per provider since all are OpenAI-compatible. See [Fallback chain](./FALLBACK.md). |
| **transformers.js VLM (SmolVLM 256M/500M)** | On-device last-resort fallback that answers with no key and no network. | The only truly zero-config tier: when every hosted option is down, the copilot still works, fully local. |
| **Tolerant action parser** | Normalizes model tool-call arguments into the typed Action space. | Models drift in how they emit coordinates, keys, and scroll amounts; the parser accepts the common variants. |

## Voice (on-device)

| Tech | Role | Why this one |
| --- | --- | --- |
| **@huggingface/transformers** and **@xenova/transformers** | Run speech-to-text (and the SmolVLM fallback) models in the renderer (WASM and WebGPU). | Fully on-device: no audio or screenshots leave the machine for these. |
| **Whisper base, Moonshine base** | The two STT engines, shown as V1 and V2 in the collapsible voice pill. | The old tiny-WASM V1 was dropped for quality; both remaining engines are WebGPU. See [Voice](./VOICE.md). |

## Sandboxed operator environment

| Tech | Role | Why this one |
| --- | --- | --- |
| **Docker via Colima** | Runs the sandboxed Linux desktop as a container. | Isolates the agent from your real machine. Colima avoids the Docker Desktop license block. |
| **Xvfb + fluxbox + x11vnc + noVNC** | A headless X display, a tiny window manager, and a browser-based live view. | Lets you watch the agent work in a real window. |
| **Chromium + xdotool + scrot** | The browser the agent drives, plus input synthesis and screenshots inside the container. | Real browser behavior; simple, scriptable control. |
| **Control server (Python)** | Exposes `/health`, `/screenshot`, `/dom`, `/action` inside the container. | One HTTP surface the app drives for perception and action. |

## Persistence and security

| Tech | Role | Why this one |
| --- | --- | --- |
| **Electron safeStorage** | Encrypts API keys with the OS keychain. | Keys never sit on disk in plain text. |
| **JSON on disk (userData)** | Sessions and non-secret config. | Simple, inspectable, atomic writes. |
| **contextIsolation + preload bridge** | The only path from renderer to main. | Renderers get a typed API, never raw Node or system access. |

## Testing

| Tech | Role | Why this one |
| --- | --- | --- |
| **Vitest 2** | Unit and integration tests across main, preload, and renderer logic. | Fast, Vite-native, TypeScript-friendly. |
| **fast-check** | Property-based tests for the trickier pure logic (session folds, capture math, chat flow). | Finds edge cases example tests miss. |

## Why the split reasoning clients

Copilot mode answers a human ("what do I do next?") so a vision chat completion
is perfect. Operator mode answers a machine ("what is the next action?") so it
needs strict, typed tool calling against a fixed Action space. Same key, same
provider family, two different shapes of request.
