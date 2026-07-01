# Sandbox container

The default operator environment, "Sandboxed browser", is a small Linux desktop
running inside a Docker container. The agent drives a real Chromium browser in
there, and you watch it live in your own window over noVNC. It never touches your
Mac.

The image files live in `operator-docker/`.

## What is inside the image

```
  ┌───────────────────────── container: click-operator-desktop ─────────────────────────┐
  │                                                                                       │
  │   Xvfb (:99)          offscreen X display at a fixed resolution                       │
  │   fluxbox             tiny window manager                                             │
  │   x11vnc (:5900)      exposes the display over VNC, with a visible cursor             │
  │   noVNC (:6080)       browser-based VNC client  <── the live view you watch           │
  │   Chromium (:9222)    the browser the agent drives, with remote debugging on          │
  │   xdotool             synthesizes real mouse + keyboard input (cursor glides)         │
  │   scrot               takes screenshots of the display                                │
  │   control server (:5000, Python)   the one HTTP surface the app drives                │
  │                                                                                       │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

Base image is `debian:bookworm-slim`. The default page is a search engine so a
web goal has a useful starting point.

## The control server

The app never pokes the container's guts directly. It talks to one HTTP surface,
the control server, on port 5000.

| Endpoint | Method | What it does |
| --- | --- | --- |
| `/health` | GET | Readiness check (used while waiting for boot). |
| `/screenshot` | GET | A PNG of the current desktop. |
| `/dom` | GET | Interactive elements (links, buttons, fields) with SCREEN coordinates, read over Chromium's dev protocol. This is the hybrid perception layer. |
| `/action` | POST | Maps one typed Action to xdotool. The mouse glides smoothly to targets so you can follow it. |

```
  app (ContainerDesktopEnvironment)          container control server (:5000)
  --------------------------------           --------------------------------
  capture()  ── GET /screenshot ──────────►  scrot -> PNG
             ── GET /dom ─────────────────►  CDP query -> [ {role,label,x,y}, ... ]
  execute()  ── POST /action ─────────────►  xdotool moves/clicks/types
```

## How the app runs it

You do not start the container. When you pick "Sandboxed browser" and start a
goal, the app runs the image and opens a live view; when the task ends or you
switch environments, it tears the container down.

```
  pick "Sandboxed browser" + start goal
        │
        ▼
  docker rm -f click-operator-desktop        (clear any old one)
  docker run -d ... click-operator-desktop:latest
        │
        ▼
  wait for /health to go green
        │
        ▼
  open the noVNC live desktop window (points at :6080)
        │
        ▼
  loop: /screenshot (+ /dom) -> reason -> POST /action -> repeat
```

Ports: 6080 is the noVNC live view, 5000 is the control API, and 9222 is
Chromium's remote debugging (internal to the container, used only for `/dom`).

## Building the image

Docker Desktop is often blocked in corporate environments, so we use Colima.

```bash
brew install colima docker
colima start
docker context use colima

cd operator-docker
docker build -t click-operator-desktop:latest .
```

Rebuild whenever you change the `Dockerfile`, `entrypoint.sh`, or
`control_server.py`. The app always runs the `click-operator-desktop:latest` tag.

## Why hybrid perception

A screenshot alone forces the model to spend vision tokens locating everyday
targets like a search box. By also handing it the page's interactive elements in
screen coordinates, the model can reason over cheap structured text for "where do
I click" and reserve the image for context. Fewer vision tokens, more reliable
clicks.

```
   screenshot ─────────────┐
                           ├──►  model  ──►  "click the element at (640, 380)"
   interactive elements ───┘
   (role, label, x/y)
```

## Files in operator-docker/

| File | Role |
| --- | --- |
| `Dockerfile` | Builds the sandbox image. |
| `entrypoint.sh` | Boots Xvfb, fluxbox, x11vnc, noVNC, Chromium, then the control server. |
| `control_server.py` | The active control server (health, screenshot, dom, action). |
| `control-server.mjs` | An earlier Node prototype of the control server, kept for reference. The Python one is what the image runs. |

## Safety note

The container is a sandbox: no access to your files, desktop, or other apps. Even
so, every action still passes through the operator's safety gate and kill switch.
See [Safety model](./SAFETY.md).
