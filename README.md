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

- **Drag** an image or a screenshot file (e.g. from the Desktop) anywhere onto the
  app.
- Use the **paperclip** button to attach images or a PDF (PDFs are rasterized
  page-by-page).

## What it does

- **Sees your screen** — capture a region, a window, or the full screen with the
  shortcuts above.
- **Stages before sending** — captures and attachments collect in a carousel
  above the input so you can send several at once.
- **Answers by text or voice** — type, or tap the mic and talk (on-device, live;
  two engines selectable from the voice pill).
- **Routes automatically** — a command runs the agent; a question is answered by
  the copilot. No manual mode-flipping needed.
- **Never fully stops** — a fallback chain (free hosted models, then on-device
  models) answers even with no network key. See [Fallback chain](./docs/FALLBACK.md).
- **Drives a real browser via its DOM** — Computer or Browser Use can operate a
  Playwright-controlled Chromium using the page's structure (links, buttons,
  fields, text) rather than pixel-guessing, so it's reliable and works on text
  models. It can also control your Mac desktop.
- **Shows what it's doing** — a live checklist of the agent's steps (tick per
  done step, spinner while working) and a status pill showing the model actually
  in use and whether it's acting via the DOM (API) or vision.
- **Adapts and retries** — if a step fails or a provider hiccups, it backs off and
  tries a different approach instead of giving up.
- **Stays safe** — autonomy levels, an emergency stop (Cmd+Shift+Esc), and an
  "in control" indicator. See [Safety model](./docs/SAFETY.md).
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
   and picks **Browser Use** for web tasks or **Compute Use (My Mac)** for
   Mac tasks automatically. (You can also flip the mode button yourself.)
2. In the header, adjust the environment, the autonomy (**Autonomous** default, or
   **Manual**), and the **step budget** if you want.
3. Watch the steps stream into the checklist. Hit **Cancel** to stop and change a
   setting, or **Cmd+Shift+Esc** / the on-screen Emergency Stop to halt.

**Permissions:** Browser Use needs no special macOS permission. Compute Use (My
Mac) needs both **Screen Recording** and **Accessibility** (to synthesize input);
the app opens the exact System Settings pane when they're missing. Voice needs
**Microphone**. See [Setup](./docs/SETUP.md).

## Providers and keys (free options)

The app runs on your OpenAI-compatible endpoint, free hosted models, or local
on-device models. Paste any of these free keys once in Settings and they're used
automatically:

- **Google Gemini** (`gemini-2.5-flash`) — best free vision + tool-calling; the
  recommended choice for the agent. Key: aistudio.google.com/apikey
- **OpenRouter** (`openrouter/free` router) — auto-selects a free model. Key:
  openrouter.ai/keys
- **Zhipu GLM** (`glm-4v-flash`) — free vision model.

On-device fallback (zero config): SmolVLM for screenshots and SmolLM2 for text-only
questions, so Smart Copilot answers even fully offline (after a one-time model
download). See [Fallback chain](./docs/FALLBACK.md) and
[AI gateway & models](./docs/AI-GATEWAY.md).

## Download & run (macOS)

> Demo video: _add your Loom/YouTube link here_

1. Download the latest `.dmg` from the [Releases](../../releases) page.
2. Open it and drag **Computer or Browser Use and Smart Copilot** to Applications.
3. First launch: the app is not code-signed, so macOS will block it. **Right-click
   the app -> Open**, then confirm. (Once only.) If it still refuses:
   ```bash
   xattr -cr "/Applications/Computer or Browser Use and Smart Copilot.app"
   ```
4. Allow **Screen Recording** and, for Compute Use, **Accessibility** in System
   Settings -> Privacy & Security; **Microphone** for voice.

Smart Copilot answers with the on-device fallback even with no key, so you can try
it immediately. For best quality add a free key (above). Browser Use runs on
Playwright's bundled Chromium in development; see [Setup](./docs/SETUP.md).

## Documentation

| Doc | What's inside |
| --- | --- |
| [Setup](./docs/SETUP.md) | Install, configure keys, permissions, and run both modes. Start here. |
| [How it works](./docs/HOW-IT-WORKS.md) | Plain-language walkthrough of Smart Copilot with flow diagrams. |
| [Operator engine](./docs/OPERATOR.md) | The autonomous agent: modes, the perceive -> reason -> act loop, environments. |
| [Architecture](./docs/ARCHITECTURE.md) | Electron processes, windows, IPC, source layout for both halves. |
| [Tech stack](./docs/TECH-STACK.md) | Every technology used and why. |
| [IPC channels](./docs/IPC-CHANNELS.md) | The full main <-> renderer channel map. |
| [Safety model](./docs/SAFETY.md) | Autonomy levels, the safety gate, the kill switch, the in-control indicator. |
| [Fallback chain](./docs/FALLBACK.md) | Your provider -> free hosted models -> on-device, so answers never fully stop. |
| [Sandbox container](./docs/SANDBOX-CONTAINER.md) | The optional Docker Linux desktop and noVNC live view. |
| [Voice dictation](./docs/VOICE.md) | On-device speech-to-text: the worker, the engines, tuning. |
| [AI gateway & models](./docs/AI-GATEWAY.md) | OpenAI-compatible providers, the free fallback chain, credentials, model choice. |
| [Development & packaging](./docs/DEVELOPMENT.md) | Build, package, and manual QA. |

## For developers (quick start)

```bash
npm install
npm run dev        # run in development
npm test           # Vitest suite
npm run typecheck  # TypeScript checks
npm run build      # build main + preload + all renderer entries
```

---

Personal R&D project. Tech: Electron + electron-vite + React + TypeScript;
on-device Whisper/Moonshine + SmolVLM/SmolLM2 (transformers.js) for voice and
offline fallback; OpenAI-compatible provider clients;
Playwright-driven Chromium for DOM-based browser use; and an optional Dockerized
Linux desktop for the sandboxed operator.
