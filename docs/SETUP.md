# Setup

This is the full "get it running on a fresh Mac" guide, covering both copilot
mode and operator mode. If you only want copilot mode, you can skip the Docker
and Colima parts.

## 1. Prerequisites

| Thing | Why | Notes |
| --- | --- | --- |
| macOS | The app is macOS-only right now. | Apple Silicon or Intel. |
| Node.js 18+ | Build and dev tooling (electron-vite, Vitest). | `node -v` to check. |
| An AI provider key | Optional; improves copilot answers and operator reasoning. | Any OpenAI-compatible provider you control. Free hosted options are in Settings. |
| Colima + Docker CLI | Only for the operator's **Sandboxed browser** environment. | Docker Desktop is not required (and may be license-blocked at work). |

## 2. Install

```bash
git clone <your-fork-or-repo>
cd click-copilot
npm install
```

Run it in development (hot reload for the UI, auto-rebuild for the main process):

```bash
npm run dev
```

Or build and preview a production bundle:

```bash
npm run build
npm start
```

## 3. Configure credentials

Both modes can reason through the same OpenAI-compatible provider. You enter it
once, in the app.

1. Launch the app and open **Settings** (top right of the sidebar).
2. Fill in your gateway **base URL**, a **model** id, and your **API key**.
3. Save.

The key is encrypted at rest with Electron `safeStorage` (OS keychain backed),
stored separately from the plain-text config, and never written into
`config.json`.

```
   Settings form
        |
        v
   ConfigStore.save()
        |
        +--> config.json          (baseURL, model)      not secret
        +--> gateway-key.enc       (API key, encrypted)  keychain backed
```

### How the operator gets the same providers

The operator keeps its own isolated config (so it cannot clobber the copilot's),
but on every launch the app seeds that config from the primary provider and free
hosted keys you already saved.

```
  launch
    |
    v
  read copilot provider config + encrypted keys
    |
    v
  operator ConfigStore.saveProviders(...)
    |
    v
  operator can now reason
```

## 4. Grant macOS permissions

| Permission | Needed for | When asked |
| --- | --- | --- |
| Screen Recording | Copilot capture, and operator in **My Mac** mode | First capture / first local run |
| Accessibility | Operator input synthesis in **My Mac** mode | First local run |
| Microphone | Voice dictation | First time you tap the mic |

Grant them in System Settings -> Privacy & Security. The **Sandboxed browser**
environment needs none of these, because it never touches your real desktop.

## 5. Set up the sandboxed browser (operator only)

The sandboxed browser runs inside a Docker container: a small Linux desktop with
Chromium, watched live over noVNC. Because Docker Desktop is often blocked in
corporate environments, we use Colima.

Install and start Colima (one time):

```bash
brew install colima docker
colima start
docker context use colima   # if not already selected
```

Build the sandbox image (one time, or after changing the container):

```bash
cd operator-docker
docker build -t click-operator-desktop:latest .
```

That single image tag, `click-operator-desktop:latest`, is what the app runs.
You do not start the container yourself. The app does `docker run ...` when you
pick **Sandboxed browser** and start a task, and tears it down afterward.

```
  pick "Sandboxed browser" + start goal
        |
        v
  docker run click-operator-desktop:latest   (Xvfb + fluxbox + Chromium + noVNC)
        |
        v
  live desktop window opens (noVNC)  <-- you watch here
        |
        v
  agent perceives + acts through the in-container control server
```

See [Sandbox container](./SANDBOX-CONTAINER.md) for what is inside the image.

## 6. Verify

```bash
npm run typecheck   # no type errors
npm test            # Vitest suite passes
npm run build       # main + preload + 4 renderer entries build
```

If all three are green, you are set. Open the app, try a copilot capture, then
flip on Operator and hand it a small web goal.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Authentication failed" / "API key format" | Provider key or endpoint is wrong | Re-enter the provider settings in Settings. |
| Operator says "configure a provider" | No provider was seeded yet | Save a primary, local, or free hosted provider in Settings first. |
| Sandboxed browser will not start | Colima not running, or image missing | `colima start`, then rebuild the image. |
| Nothing captures in copilot mode | Screen Recording not granted | System Settings -> Privacy & Security. |
| Voice mic does nothing | Microphone not granted | System Settings -> Privacy & Security. |
