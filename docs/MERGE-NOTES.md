# Merge notes: how Click Operator was folded in

Click Operator started life as a separate Electron app. It has been merged into
Click Copilot so there is one app, one UI, and one set of credentials. This doc
records how that was done and, more importantly, how the two engines stay out of
each other's way.

## The goal

Keep everything users love about Click Copilot (its look, its capture flow, its
input field, its colors) and add the operator as a mode you toggle on, rather than
bolting on a second app or restyling anything.

```
   BEFORE                              AFTER
   ------                              -----
   click-copilot   (advise)            click-copilot
   click-operator  (act)                 ├─ copilot mode  (advise)   default
                                          └─ operator mode (act)      toggle
```

## Strategy: vendor as an isolated subtree

The whole operator main-process engine was copied under `src/main/operator/` as a
self-contained subtree. It was not rewritten to share Copilot's config, sessions,
or windows. Instead it runs alongside, wired to the existing sidebar window.

```
   src/main/
     ├─ (copilot engine files)         window.glass,  @shared/*
     └─ operator/
          ├─ main/     the engine       window.operator, op:* channels
          └─ shared/   operator types    @op-shared/*
```

## The four isolation seams

Because both engines live in one process and one window, four things had to be
kept separate or they would collide.

### 1. Type worlds (path aliases)

Both projects used `@shared/*` for their own types, and those types differ. The
vendored operator types moved to a second alias so nothing gets confused.

```
   @shared/*      ->  src/shared/*                 (copilot types)
   @op-shared/*   ->  src/main/operator/shared/*   (operator types)
```

Registered in `tsconfig.json` and in all three electron-vite targets (main,
preload, renderer).

### 2. IPC channel names

Copilot and operator both had channels like `session:get`, `config:save`, and
`error:show`. Registering the same channel twice crashes Electron, and shared
event channels would cross the streams. Every operator channel is prefixed:

```
   session:get     (copilot)     vs    op:session:get     (operator)
   config:save     (copilot)     vs    op:config:save     (operator)
   error:show      (copilot)     vs    op:error:show      (operator)
```

See [IPC channels](./IPC-CHANNELS.md) for the full map.

### 3. On-disk state

Both engines share the same `userData` directory, so their files were renamed to
avoid clobbering each other.

```
   copilot                       operator
   -------                       --------
   config.json                   operator-config.json
   gateway-key.enc               operator-provider-key-*.enc
   sessions/                     operator-sessions/
```

### 4. Windows

The operator originally created its own Console window. In the merge, it emits
every event to the existing sidebar window instead (injected as `getHostWindow`),
so operator activity renders inside the Copilot chat. The operator still owns two
of its own windows: the "agent in control" indicator overlay and the noVNC live
desktop window.

```
   operator services ── getHostWindow() ──► the Copilot sidebar window
                     ── own WindowManager ─► indicator overlay
                                          └► noVNC desktop window (sandbox)
```

## Two bridges on one preload

The single preload now exposes both bridges on `window`:

```
   window.glass      the copilot API (unchanged)
   window.operator   the operator API (op:* channels)
```

The sidebar uses `window.glass` in copilot mode and `window.operator` in operator
mode. The indicator overlay uses `window.operator` for the kill switch.

## Credentials: seeded, not re-entered

The operator keeps its own config file, but there is no separate credential UI.
On launch the app reads the provider settings and keys you already saved and
seeds the operator config with the same OpenAI-compatible providers.

## What was dropped

- The **headless Playwright browser** environment was removed *at merge time*,
  leaving only the sandboxed Linux desktop and the local Mac. That step is
  history now: Playwright later returned as today's **visible, DOM-first
  Browser Use** environment (`environment/browser-environment.ts`), so
  `playwright` **is** a project dependency again. What stayed dropped is the
  old *headless* variant — the current one launches a Chromium window you can
  watch.
- The old **"never modify click-copilot" independence guard** (a byte-for-byte
  test in the operator project) was retired, since the merge intentionally
  reverses that constraint.

## Verifying the merge

```bash
npm run typecheck   # both type worlds resolve, no collisions
npm test            # copilot suite passes (303 tests at time of merge)
npm run build       # main + preload + 4 renderer entries (incl. indicator)
```

## Mental model

If you remember one thing: the operator is a guest engine living in the Copilot
house. It has its own room (subtree), its own name tag (`op:` channels), its own
drawers (isolated files), and its own type dictionary (`@op-shared`), but it eats
at the same table (the sidebar window) and uses the same key (seeded credentials).
