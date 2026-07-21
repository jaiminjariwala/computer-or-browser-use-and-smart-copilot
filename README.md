# Computer or Browser Use and Smart Copilot

**One app that both advises you about your screen and can do the work for you.**

Normally, asking an AI about something on your screen means: take a screenshot ->
drag it into the chat (or click attach -> hunt for the file -> paste) -> then type
your question. This app collapses that: press a shortcut, grab a region, and it
sits above your input ready to ask. Ask by text or voice, and it tells you the
next step.

And when you'd rather the AI *do* the task than advise, just tell it. A command
like "open youtube and play a song" hands off to the autonomous agent, which
drives a real browser (or your Mac) on its own, one perceive -> reason -> act step
at a time, while you watch.

```
  Smart Copilot:            you capture the screen, it advises, YOU act.
  Computer or Browser Use:  you hand it a goal, IT acts, you watch (and can stop it).
```

## Two modes, one app

| Mode | What it does | Who acts |
| --- | --- | --- |
| **Smart Copilot** (default) | Looks at a screenshot and tells you the next step. | You do. |
| **Computer or Browser Use** (toggle) | Takes a goal and completes it autonomously in a chosen environment. | The agent does. |

You can switch with the mode button at the top of the sidebar, but you usually
don't need to: when you type, the app **routes automatically**. A question or a
"how do I..." (or a message with a screenshot) stays in Smart Copilot; a command
like "open youtube and play closer" or "turn on dark mode" flips to Computer or
Browser Use and picks the right environment for you.

Each mode keeps its own separate chat and history; toggling swaps between them.

## Capturing your screen

Capture uses macOS's own native screenshot tool, bound to the app's shortcuts so
a shot only ever lands here when *you* press one of them (your normal macOS
screenshots for other apps are never hijacked):

| Shortcut | Captures |
| --- | --- |
| **Cmd+Shift+D** | A region (crosshair; Space toggles window capture) |
| **Cmd+Shift+F** | A specific window (click to pick) |
| **Cmd+Shift+S** | The full screen |

The shot appears as a thumbnail in a carousel above the input, so you can stack
several and send them together. You can also:

- **Drag** an image, a screenshot file, or a **video** (mp4/m4v/mov/webm/ogv)
  anywhere onto the app.
- Use the **paperclip** button and pick **Files** to attach images, a PDF
  (rasterized page-by-page), or a video file — or pick **Camera** to record a
  short video with your device's camera; it lands in the same carousel as a
  playable preview while frames are sampled for the AI.

## What it does

- **Sees your screen** — capture a region, a window, or the full screen with the
  shortcuts above.
- **Stages before sending** — captures and attachments collect in a carousel
  above the input so you can send several at once.
- **Understands short videos** — attach or record a video and it is sampled
  into at most 12 chronological frames the vision model can read (up to 2
  videos per message, 250 MB each). The raw video never leaves your Mac; only
  the sampled frames are sent.
- **Answers by text or voice** — type, or tap the mic and talk (on-device
  Whisper dictation, live).
- **Routes automatically** — a command runs the agent; a question is answered by
  the copilot. No manual mode-flipping needed.
- **Zero-friction first run** — with no key configured, the first question
  answers with an in-chat setup card: paste one free key (Gemini or OpenRouter)
  right there. See [Fallback chain](./docs/FALLBACK.md).
- **Drives a real browser through its DOM** — Browser Use operates a
  Playwright-controlled Chromium using page text, links, buttons, and fields
  instead of relying on pixel guesses.
- **Works across browser tabs** — it can open, close, switch, and follow popup
  tabs while retaining bounded active-tab context for research and comparison
  tasks. Actions are bound to the exact tab and tab-lifecycle generation that
  were observed; even a popup that opens and closes before execution forces a
  fresh observation instead of resurrecting stale context.
- **Fills forms more safely** — focused fields use DOM-aware filling, and native
  HTML validation blocks Enter or submit clicks while required fields are
  invalid.
- **Offers reusable task starters** — built-in research, comparison, and safe-form
  templates plus up to five goals from the current renderer session fill the
  composer for review; they never auto-run. Sensitive-looking goals are skipped,
  and deleting operator history clears the recent list.
- **Learns without replaying sensitive history** — successful progress is rebuilt
  from a small allowlist of static action categories, and at most three related
  completed sessions can supply a few sanitized sub-steps under a generic prior-
  task label. Screenshots, observations, coordinates, typed values, rationales,
  completion prose, and complete trajectories are not recalled.
- **Shows what it is doing without echoing private inputs** — activity rows explain
  semantic actions, success or failure, and DOM/API versus Vision mode while
  hiding typed values and raw coordinates.
- **Adapts and retries** — if a step fails or a provider hiccups, it records the
  outcome and tries a different approach instead of immediately giving up.
- **Stays safe** — autonomy levels, a step budget, an emergency stop
  (Cmd+Shift+Esc), and an "in control" indicator. See
  [Safety model](./docs/SAFETY.md).
- **Keeps chats visible while work runs** — a persistent desktop rail shows each
  chat's title and compact progress, highlights the active chat, and animates the
  running description with a soft green status dot (with reduced-motion fallbacks).
- **Supports secure GitHub sign-in** — the bottom-left account entry uses GitHub
  Device Flow; verification happens in the system browser and the encrypted
  access token stays in the Electron main process.
- **Floats when you want** — a pin toggle in the header keeps the window on top;
  off by default.

## How to use it

### Smart Copilot (default)

1. Open the app.
2. Capture with **Cmd+Shift+D** (region), **Cmd+Shift+F** (window), or
   **Cmd+Shift+S** (full). The shot lands above the input.
3. (Optional) add more captures, drag in an image, or attach with the paperclip.
4. Type or speak your question and press **Enter**.
5. Read the next step in the chat.

### Computer or Browser Use

1. Just type a command ("open youtube and play closer by the chainsmokers", or
   "open system settings and turn on dark mode"). The app switches to the agent
   and picks **Browser Use** for web tasks or **Compute Use (My Mac)** for Mac
   tasks automatically. You can also flip the mode button yourself.
2. In the header, adjust the environment, autonomy (**Autonomous** default, or
   **Manual**), and the **step budget** if you want.
3. Optionally choose a task template, edit its placeholders, and submit it.
4. Watch the privacy-aware activity checklist. Hit **Cancel** to stop and change
   a setting, or **Cmd+Shift+Esc** / the on-screen Emergency Stop to halt.

**Permissions:** Browser Use needs no special macOS permission. Compute Use (My
Mac) needs both **Screen Recording** and **Accessibility** (to synthesize input);
the app opens the exact System Settings pane when they are missing. Voice needs
**Microphone**; the in-app video recorder needs **Camera** (and uses the
microphone for the recording's audio when allowed). See [Setup](./docs/SETUP.md).

## Providers and keys (free options)

The app runs on your own OpenAI-compatible endpoint (corporate or personal) or
a free hosted key. Paste either free key once — in Settings, or directly in the
in-chat setup card that appears on your first question:

- **Google Gemini** (`gemini-2.5-flash`) — recommended free vision and
  tool-calling option. Key: aistudio.google.com/app/apikey
- **OpenRouter** (`openrouter/free` router) — auto-selects a free model. Key:
  openrouter.ai/settings/keys

See [Fallback chain](./docs/FALLBACK.md) and
[AI gateway & models](./docs/AI-GATEWAY.md).

## GitHub account (optional)

The account entry at the bottom-left uses GitHub OAuth Device Flow. It opens the
verification page in your normal browser and shows the short code in the rail.
The app never bundles a client secret, and the resulting access token is
encrypted with Electron `safeStorage`; only your login/display name reaches the
renderer. Repository owners must configure the public OAuth client ID as
described in [Development & packaging](./docs/DEVELOPMENT.md#github-oauth-device-flow).

## Download & run (macOS)

> Demo video: _add your Loom/YouTube link here_

1. Download the latest `.dmg` from the [Releases](../../releases) page.
2. Open it and drag **Computer or Browser Use and Smart Copilot** to Applications.
3. First launch: the app is not code-signed, so macOS will block it. **Right-click
   the app -> Open**, then confirm. Once only. If it still refuses:
   ```bash
   xattr -cr "/Applications/Computer or Browser Use and Smart Copilot.app"
   ```
4. Allow **Screen Recording** and, for Compute Use, **Accessibility** in System
   Settings -> Privacy & Security; **Microphone** for voice; **Camera** if you
   use the in-app video recorder.

On first run, Smart Copilot walks you through pasting a free key directly in
the chat — about a minute of setup (above). Browser Use runs on Playwright's
Chromium in development; see [Setup](./docs/SETUP.md).

## Documentation

| Doc | What's inside |
| --- | --- |
| [Setup](./docs/SETUP.md) | Install, configure keys, permissions, and run both modes. Start here. |
| [How it works](./docs/HOW-IT-WORKS.md) | Plain-language, analogy-driven walkthrough of the whole app, with diagrams. |
| [Operator engine](./docs/OPERATOR.md) | Agent loop, memory, browser tabs, form safety, environments, and evaluations. |
| [Architecture](./docs/ARCHITECTURE.md) | Electron processes, windows, IPC, source layout, and evaluation seams. |
| [Tech stack](./docs/TECH-STACK.md) | Every technology used and why. |
| [IPC channels](./docs/IPC-CHANNELS.md) | The full main <-> renderer channel map. |
| [Safety model](./docs/SAFETY.md) | Autonomy levels, the safety gate, the kill switch, the in-control indicator. |
| [Fallback chain](./docs/FALLBACK.md) | Your provider -> free hosted keys, plus the in-chat first-run setup card. |
| [Sandbox container](./docs/SANDBOX-CONTAINER.md) | The optional Docker Linux desktop and noVNC live view. |
| [Voice dictation](./docs/VOICE.md) | On-device speech-to-text: the worker, the engines, tuning. |
| [AI gateway & models](./docs/AI-GATEWAY.md) | OpenAI-compatible providers, credentials, and model choice. |
| [Development & packaging](./docs/DEVELOPMENT.md) | Validation, deterministic agent evaluations, packaging, and manual QA. |

## For developers (quick start)

```bash
npm install
npm run dev            # run in development
npm run eval:operator  # deterministic AgentLoop scenarios + JSON report
npm test               # Vitest suite
npm run typecheck      # TypeScript checks
npm run build          # build main + preload + all renderer entries
```

`npm run eval:operator` runs the production `AgentLoop` headlessly against six
scripted scenarios and writes `artifacts/operator-evals/latest.json`. The generated
report is gitignored. See [Development & packaging](./docs/DEVELOPMENT.md) for the
metrics and full validation sequence.

---

Personal R&D project. Tech: Electron + electron-vite + React + TypeScript;
Monaco Editor for code viewing; on-device Whisper (transformers.js) for
dictation; a MediaRecorder + canvas
pipeline that turns local video attachments into bounded JPEG frame sequences
for vision models; OpenAI-compatible provider clients; GitHub OAuth Device Flow
with a safeStorage-encrypted token kept in the main process; Playwright-driven
Chromium for DOM-based browser use; and an optional Dockerized Linux desktop
for sandboxed experiments.
