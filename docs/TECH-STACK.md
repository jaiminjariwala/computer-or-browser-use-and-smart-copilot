# Tech stack

Every technology below is used by the current codebase and has a specific role.
Version numbers are the installed major families from `package.json`.

## At a glance

```
  ┌──────────────────────────────────────────────────────────────┐
  │ Electron 43 (privileged main + isolated renderers)           │
  │                                                              │
  │ UI             React 18 + TypeScript 5 + Monaco Editor       │
  │ Build          electron-vite 5 + Vite 7 + electron-builder   │
  │ Copilot AI     OpenAI-compatible client + local fallback     │
  │ Operator AI    typed provider chain + deterministic loop     │
  │ Browser use    Playwright 1.61 + DOM-first Chromium          │
  │ Voice/local AI transformers.js (Whisper/Moonshine/SmolVLM)   │
  │ Tests          Vitest 4 + fast-check 4                       │
  │ Agent evals    tsx 4.20.6 + scripted deterministic seams     │
  └──────────────────────────────────────────────────────────────┘
```

## Runtime and build

| Tech | Role | Why this one |
| --- | --- | --- |
| **Electron 43** | Desktop shell with a privileged main process and isolated renderer windows. | Provides global hotkeys, screen capture, native permission APIs, input control, and a Chromium UI. |
| **electron-vite 5 / Vite 7** | Development server and bundler for main, preload, and renderer targets. | Fast renderer HMR plus one build pipeline for all Electron targets, with compatible peer versions. |
| **electron-builder 26** | Builds the macOS `.app`, `.dmg`, and `.zip`. | Mature packaging, entitlements, signing, and release artifacts. |
| **TypeScript 5** | Types the main process, preload bridge, renderers, action space, sessions, and reports. | Compile-time contracts are especially valuable across IPC and agent safety boundaries. |

## UI and documents

| Tech | Role | Why this one |
| --- | --- | --- |
| **React 18** | Sidebar chat, capture overlay, activity view, settings, and indicator UI. | Component state maps cleanly to the app's independent conversations and panels. |
| **Monaco Editor 0.52** | Readable code-view panels in chat. | Syntax highlighting, familiar editor behavior, and large-document handling without building an editor from scratch. |
| **react-markdown + remark-gfm** | Renders assistant answers and operator explanations as Markdown. | Keeps model output readable while user text remains plain. |
| **framer-motion 11** | Focused UI transitions. | Declarative motion without owning animation lifecycle code. |
| **@fontsource-variable/inter** | Self-hosted UI typography. | Consistent rendering offline and under the renderer CSP. |
| **pdfjs-dist 6** | Rasterizes attached PDF pages into image cards. | Vision models receive page images rather than unsupported raw PDF bytes. |

## AI and reasoning

The two app modes share provider concepts but produce different outputs.

```
  Smart Copilot                      Computer or Browser Use
  -------------                      -----------------------
  image(s) + question                observation + bounded history
          │                                      │
          ▼                                      ▼
  chat completion text               typed action/completion/help/failure
          │                                      │
          ▼                                      ▼
  advice for the user                safety gate -> environment executor
```

| Tech | Role | Why this one |
| --- | --- | --- |
| **openai SDK 4** | Calls OpenAI-compatible primary and hosted fallback endpoints. | One client works with configured endpoints and compatible hosted providers. |
| **Operator provider chain** | Routes typed reasoning across configured and fallback providers. | Provider failures remain isolated from the loop state machine. |
| **Tolerant action parser** | Normalizes common model variations into the fixed `Action` union. | Valid intent is not discarded solely because a provider formatted coordinates or key chords differently. |
| **Deterministic trajectory summaries** | Rebuild successful progress from static action categories without another model call. | Avoids extra latency and cost while excluding rationales, typed values, coordinates, and free-form result prose. |
| **Bounded local session memory** | Recalls sanitized summaries from up to three related completed sessions. | Reuses useful approaches under a generic prior-task label without replaying screenshots, typed values, coordinates, raw goals, or full trajectories. |
| **transformers.js models** | Local SmolVLM/SmolLM2 fallback and on-device speech recognition. | Supplies a zero-key, local path after initial model download. |

## Browser and computer environments

| Tech | Role | Why this one |
| --- | --- | --- |
| **Playwright 1.61** | Launches and controls the visible Browser Use Chromium instance. | Exposes page text, focused fields, native form validity, popup events, and tabs directly rather than guessing from pixels. |
| **DOM-first hybrid execution** | Snaps nearby coordinates to interactive controls and reports `api` versus `vision`. | Structured actions are more reliable while coordinate fallback preserves the shared action contract. |
| **macOS capture and input backends** | Power Compute Use on the local Mac. | They operate the real desktop under explicit Screen Recording and Accessibility permissions. |
| **Docker/Colima container backend** | Optional isolated Linux desktop service. | Keeps experimental desktop automation away from the host machine. |
| **Xvfb + fluxbox + x11vnc + noVNC** | Display server, small window manager, and watchable remote desktop for the container. | Provides a complete but lightweight graphical Linux environment. |
| **Chromium + xdotool + scrot** | Browser, synthesized input, and screenshots inside the container. | Simple primitives behind the container control server. |

## Voice (on-device)

| Tech | Role | Why this one |
| --- | --- | --- |
| **@huggingface/transformers 3** and **@xenova/transformers 2** | Run speech and local vision/text models in renderer workers using WASM/WebGPU. | Audio and local-fallback screenshots can stay on the machine. |
| **Whisper base / Moonshine base** | Two selectable dictation engines. | Gives a quality/speed choice while retaining local processing. |

## Persistence and security

| Tech | Role | Why this one |
| --- | --- | --- |
| **Electron safeStorage** | Encrypts provider secrets with the OS keychain. | Credentials are not persisted as plain text. |
| **JSON under Electron `userData`** | Stores sessions and non-secret configuration. | Simple, inspectable records with atomic persistence. |
| **Renderer `sessionStorage`** | Keeps up to five recent editable goals for the current renderer session. | Avoids durable copies, skips common sensitive markers, and clears with operator-history deletion. |
| **contextIsolation + preload bridges** | Exposes typed `window.glass` and `window.operator` APIs. | Renderers never receive unrestricted Node or system access. |

## Testing and evaluation

| Tech | Role | Why this one |
| --- | --- | --- |
| **Vitest 4** | Existing unit, integration, and property-oriented test suite. | Vite-native TypeScript execution and fast non-watch CI runs. |
| **fast-check 4** | Generates edge cases for pure state, parsing, safety, and geometry logic. | Tests invariants beyond hand-picked examples. |
| **tsx 4.20.6** | Runs the standalone TypeScript AgentLoop evaluation CLI. | Executes the real TypeScript modules and path aliases without emitting a separate build or disguising the benchmark as a unit test. |
| **Deterministic AgentLoop harness** | Runs four goal scenarios and two guardrails through production orchestration with scripted seams. | Uses exact-action-matched world-state transitions, separates blocks from executor failures and actual retries from failures, and produces byte-repeatable reports without Electron, network calls, or real input. |

## Why the split reasoning clients

Smart Copilot answers a person ("what should I do next?") and returns prose.
Computer or Browser Use answers the state machine ("what is the next typed
outcome?") and must conform to a fixed action contract. Keeping those request
shapes separate makes both simpler while allowing them to share compatible
provider infrastructure.
