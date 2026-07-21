# How the whole app works (plain language)

No jargon required. This is a tour of everything the app does — both modes,
the windows, the AI, the safety rails, and what ends up on your disk — told
with analogies and text diagrams. Each section also names the classic
system-design concept it demonstrates, so you can learn the patterns from
your own codebase.

For the deep technical version see
[Architecture](./ARCHITECTURE.md) · [Operator engine](./OPERATOR.md) ·
[Safety model](./SAFETY.md) · [Tech stack](./TECH-STACK.md)

---

## One app, two personalities

The app is one desktop assistant with two very different jobs:

- **Smart Copilot** is a *navigator*: it looks at what's on your screen and
  tells you the next step. You keep your hands on the wheel.
- **Computer or Browser Use** is a *chauffeur*: you name the destination
  ("open youtube and play a song") and it drives — a real browser, or your
  Mac — while you watch and can stop it at any moment.

You rarely need to switch modes yourself. When you type, a tiny offline
"receptionist" (the intent router) reads your sentence: questions
("how do I…?") stay with the navigator; commands ("open… and play…") go to
the chauffeur, which also picks the right vehicle (web browser vs. your Mac).

### The big picture

```
  ┌─────┐  type · speak · capture (⌘⇧D/F/S) · attach files
  │ You │ ─────────────────────────────────────────────────┐
  └─────┘                                                   ▼
             ┌─────────────────────────────────────────────────┐
             │              ELECTRON APP (one .app)            │
             │  ┌───────────────────────────────────────────┐  │
             │  │ Renderer windows — the UI, no privileges  │  │
             │  │ sidebar chat · capture overlay · agent-   │  │
             │  │ in-control indicator (+ Emergency Stop)   │  │
             │  └────────────────────┬──────────────────────┘  │
             │                       │ preload bridge          │
             │  ┌────────────────────▼──────────────────────┐  │
             │  │ Main process — the brain, full power      │  │
             │  │ capture · AI client · sessions · GitHub   │  │
             │  │ auth · operator loop + safety gate        │  │
             │  └───┬────────┬───────────┬─────────┬────────┘  │
             └──────┼────────┼───────────┼─────────┼───────────┘
                    │        │           │         │
        HTTPS chat  │        │ Device    │ DOM     │ macOS permissions
        completions │        │ Flow      │ control │ (TCC / entitlements)
                    ▼        ▼           ▼         ▼
             ┌───────────┐ ┌────────┐ ┌───────────┐ ┌──────────────────┐
             │ AI        │ │ GitHub │ │ Playwright│ │ Mac hardware:    │
             │ providers │ │  .com  │ │ Chromium  │ │ screen · camera  │
             │ (+ local) │ │        │ │ (visible) │ │ mic · kbd/mouse  │
             └───────────┘ └────────┘ └───────────┘ └──────────────────┘
                    │
                    ▼
             ┌──────────────────────────────────────┐
             │ Local disk: userData/                │
             │ sessions · settings · encrypted keys │
             └──────────────────────────────────────┘
```

> **Concepts:** client–server, a system-context ("C4 level 1") view, and
> privilege separation — the UI never owns the keys.

---

## The office: how the app is built inside

An Electron app is really several programs working together, and the split is
a security feature. Picture a small office:

- The **main process** is the *back office with all the keys*: it can take
  screenshots, read and write files, talk to the internet, and press keys on
  your behalf. No visitor ever walks in here.
- Each **renderer window** (the chat sidebar, the capture overlay, the
  "agent in control" indicator) is a *front desk*: pretty, interactive, and
  deliberately powerless. A front desk cannot open the safe.
- The **preload bridge** is the *service hatch* between them: a short, typed
  menu of requests the front desk may make ("send this message", "start a
  capture"). Anything not on the menu simply cannot be asked.

```
  LOW TRUST                          front desks (draw pixels, hold no keys)
  ┌──────────────┬──────────────┬──────────────┐
  │   Sidebar    │   Overlay    │  Indicator   │   contextIsolation: on
  │ chat + video │ region drag  │ e-stop badge │   nodeIntegration: off
  │  recorder    │              │              │   strict per-window CSP
  └──────┬───────┴──────┬───────┴──────┬───────┘
         │ invoke(request)      ▲ events (turn:appended, op:state…)
         ▼                      │
  ┌─────────────────────────────┴────────────────┐
  │ Preload bridge — window.glass + window.operator│  the only doorway
  └─────────────────────────────┬────────────────┘
                                ▼
  ┌──────────────────────────────────────────────┐
  │ Main process — validates every request       │  HIGH TRUST
  │ · Chromium permission handler: grants ONLY   │
  │   'media', ONLY to the trusted sidebar       │
  │ · secrets (API keys, GitHub token) encrypted │
  │   here and never sent to a renderer          │
  └──────────────────────────────────────────────┘

  ✗ blocked by design: no renderer can touch Node, the filesystem,
    the shell, screenshots, reasoning, or the mouse directly.
```

So even if a webpage or a model response tried to trick the UI, the UI itself
has no keys — it can only ring the back office through the hatch, and the back
office decides. Extra locks: the sidebar is the *only* window allowed to use
your camera/microphone, and its content-security policy allows media playback
only from local blob URLs (`media-src 'self' blob:`).

> **Concepts:** least privilege, defense in depth (isolation + CSP +
> permission handler + sender checks), and an API-gateway-style single entry
> point. Full channel list in [IPC channels](./IPC-CHANNELS.md).

---

## Sending a message (the chat flow)

When you press Enter, your message goes on a short, well-defined journey:

```
  [1] composer: you press Enter — your bubble renders immediately
        │
        ▼
  [2] intent router (offline, instant)
        │  question / attached image → stays in chat (below)
        │  imperative command → operator instead (see the loop section)
        ▼
  [3] window.glass.sendMessage → 'chat:send' across the preload bridge
        │
        ▼
  [4] ChatFlow (main): append your turn → echo it back (turn:appended)
        │              remember the ORIGIN chat id → pending(true)
        ▼
  [5] SessionManager.buildContext:
        running summary + last 4 verbatim turns + any images
        (never the whole history)
        │
        ▼
  [6] ai.complete → provider chain (next section) → ONE next step back
        │
        ▼
  [7] deliverAssistant(originId): still on that chat? append + show live.
        switched chats? append to the origin's saved copy for later.
        │
        ▼
  [8] SessionStore persists sessions/current.json (atomic write)
        + Summarizer folds older turns once more than 8 pile up
```

The nice part: the app never re-sends your whole history. The summary is like
the minutes of a long meeting — new attendees read one page, not the full
transcript.

> **Concepts:** request/response over a message bus, optimistic UI echo,
> event-driven updates, and context compaction (summarization) — the same
> trick chat products use to keep long conversations cheap.

---

## Screenshots, PDFs, images

Press **Cmd+Shift+D** and drag: macOS takes the picture natively, the app
crops it, and the shot lands as a thumbnail above the input — *staged*, not
sent. Like putting several photos in one envelope instead of mailing each
separately:

```
  ⌘⇧D region ──► permission ──► overlay ──► drag a rectangle
  ⌘⇧F window     check          opens       │
  ⌘⇧S full                                  └─ staged on release ────┐
     screen                                                          │
  paperclip → Files: images ────────────────────────────────────────┤
  paperclip → Files: PDF ──► pdf.ts renders each page to an image ──┤
  paperclip → Camera: record a video (next section) ────────────────┤
  drag & drop onto the app ─────────────────────────────────────────┤
                                                                     ▼
                                       ┌─────────────────────────────────┐
                                       │ staged carousel above the input │
                                       │ (remove any card before Send)   │
                                       └───────────────┬─────────────────┘
                                                Send    │  'chat:send-captures'
                                                        ▼
                                       one message carrying ALL the images
```

> **Concepts:** a fan-in pipeline (many sources, one sink) and staging /
> batching — collect first, commit once.

---

## Videos (and why the AI never sees a "video")

Most vision models read pictures, not movies. So the app treats a video like a
*flipbook*: it picks up to 12 well-spaced moments, draws each onto a canvas,
and sends those pages instead. You can attach a file (up to 2 videos per
message, 250 MB each) or record one from the paperclip menu's **Camera**
option — whatever camera the device you're on has.

```
  upload: mp4 / m4v / mov / webm / ogv        record: paperclip → Camera
  (paperclip → Files, or drag & drop)         getUserMedia 1280×720 + mic
                │                             MediaRecorder (≤5 min)
                │                             mic denied? retry camera-only —
                │                             recording still works, silent
                └──────────────┬──────────────┘
                               ▼
              staged card: playable preview + "Sampling frames…"
                               │
                               ▼
              extractVideoFrames()  — in the sidebar renderer
              ① reject empty or >250 MB files
              ② recover duration (recorded WebM often omits it;
                 a far seek reveals the real end time)
              ③ pick ≤12 timestamps (~1 per 4s, avoiding the
                 often-blank first/last instants)
              ④ seek + draw each frame to a canvas, downscaled
                 so the longest edge is ≤1280px
              ⑤ encode JPEGs → TurnCapture[] each tagged
                 videoFrame { sequenceId, index/count, timestamp }
                               │
                               ▼  Send (blocked + tooltip until sampling ends)
              'chat:send-captures' — the same channel screenshots use
                               │
                               ▼
              main ai.ts: each frame becomes a caption + image pair
              "Video sequence …, frame 3/11 at 0:12 — treat these
               as one video in chronological order"
```

Two promises hold throughout: the raw video never leaves your Mac (it never
even crosses the app's internal IPC — only the sampled frames do), and Send
waits until the flipbook is ready.

> **Concepts:** the adapter pattern (video adapted to an image-only API),
> bounding unbounded input (caps on count, size, and resolution), and data
> locality — process where the data already lives.

---

## The AI that refuses to give up (fallback chain)

The app treats AI providers like phone numbers on an emergency contact list.
Each step down trades some quality for availability — the classic
*graceful degradation* pattern:

```
  ai.complete(ctx)                     the request stays "pending"
        │                              until some tier answers
        ▼
  1 your own endpoint (company/personal) ── ok? ──► answer ✓
        │ failed / not set
        ▼
  2 OpenRouter → 3 Gemini              free hosted keys, tried in
        │ all failed                    order, skipped when no key
        ▼
  NOTHING configured at all? ──► the chat shows a setup card:
        │ something IS configured       paste one free key right there
        ▼
  a short error turn lands in the origin chat
  ("check your keys in Settings and try again")
```

The result: a fresh install responds to its very first message — with an
in-chat card that takes one pasted key — and a configured app degrades to an
honest, specific error instead of silence. Details and key setup in
[Fallback chain](./FALLBACK.md).

> **Concepts:** failover chains and graceful degradation — the same shape as
> CDN origin failover or multi-region request routing.

---

## The chauffeur: perceive → reason → act

When the operator takes a goal, it runs a strict loop, like a careful driver:
look, decide one move, get it checked, make the move, look again.

```
        start(goal)
  idle ────────────► perceiving ◄────────────────────────┐
                        │ observation                    │
                        ▼                                │ fresh look
                     reasoning ── question? ──► awaiting-help
                        │ ONE action            (you answer → perceive)
                        ▼
                 ┌─ SAFETY GATE ─┐   fail-closed: session live? legal
                 │  allow / deny │   state? e-stop off? permissions?
                 └──────┬────────┘   typed shape ok? budget left?
             confirm    │ allow      confirmation satisfied?
             needed?    ▼            any doubt = deny, executor
        awaiting-confirmation        never called
          approve │ decline          │
                  ▼                  ▼
                acting ──────────────┘ (result recorded, loop continues)

  paused  ← recoverable hiccup (e.g. capture failed); resume → perceiving
  TERMINAL: completed · failed · stopped (⌘⇧Esc) · budget-exhausted
```

A step budget caps how many actions a run may take; **Cmd+Shift+Esc** is the
emergency brake; and `stopAndWait` is the "engine fully off" guarantee — it
waits for every in-flight operation to settle before anything gets deleted.
The full engine tour is in [Operator engine](./OPERATOR.md).

> **Concepts:** finite state machines, terminal states, fail-closed design,
> and bounded execution (budgets as circuit breakers).

---

## Driving a real browser without grabbing the wrong thing

Browser Use drives a visible Chromium through Playwright, reading the page's
actual text, buttons, and fields (DOM-first) instead of guessing from pixels.
Browsers are slippery, though — tabs open and close, pages change under you —
so the environment carries three safety habits:

```
  every "look" gets a coat-check ticket:  { id, page, epoch }
                                                      │
  pageEpoch ticks on: popup opens · tab closes ·      │
  agent switches tabs (even a popup that opens        │
  AND closes before the action counts)                ▼
                                     act: is the ticket's epoch
                                     still current?
                                        │ yes            │ no
                                        ▼                ▼
                              execute on the EXACT   stale plan rejected →
                              page observed          fresh observation

  click near a control ──► snaps to the real element; the result honestly
                           records api (DOM path) vs vision (raw coords)
  Enter / submit click ──► native checkValidity() first; invalid required
                           fields → reportValidity(), action fails, no submit
  tabs ──► typed shortcuts (new/close/next/prev/numbered); observations
           carry ≤8 tab summaries, URLs reduced to their origin only
```

> **Concepts:** optimistic concurrency via version counters (the epoch is a
> tiny vector clock), binding actions to observations (no stale reads), and
> deterministic validation over model opinion.

---

## Memory that helps without gossiping

After a successful task, the operator keeps a *sanitized recipe card*, never a
diary:

```
  REMEMBER (only completed sessions)
    trajectory ──► allowlisted action categories only, last 6 sub-steps
    goal text  ──► one-way FNV-1a token fingerprints (raw words not kept)

  RECALL (new goal arrives)
    fingerprint the new goal ──► overlap-score candidates (≤24 checked)
    ──► inject ≤3 related sessions × ≤6 sub-steps, under the generic
        label "Related completed task", marked as untrusted history

  FORGET (you delete history)
    tombstone the ids IMMEDIATELY ──► caches + in-flight recalls
    invalidated ──► disk removal queued behind the write chain

  ✗ NEVER stored or recalled: screenshots, observations, coordinates,
    typed values, model rationales, completion prose, full trajectories,
    raw prior goals
```

Deleting history drops a *tombstone* on those ids first, so a deleted session
can never be recalled again even while disk cleanup is still in flight.

> **Concepts:** data minimization, one-way hashing for matching without
> retention, tombstones (how distributed systems make deletes stick), and
> cache invalidation done in the right order.

---

## Signing in with GitHub (without ever holding your password)

The account button uses GitHub's **Device Flow**, the same pattern TVs use:

```
  sidebar            main process                    github.com
  ───────            ────────────                    ──────────
  click "Log in" ──► start login (attempt = N)
                     clear any old token
                     request device code ──────────► short code issued
  show the code ◄─── { user_code, verify URL }
  "ABCD-1234"        open your real browser ───────► you approve there
                     poll every ≥5s (backs off on
                     "slow_down") ─────────────────► token when approved
                     verify identity FIRST (GET /user)
                     encrypt + save github-token.enc (keychain)
  "signed in as" ◄── status only: @login + name
      @you           ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                     the token itself NEVER crosses this line
```

The app never sees your password and ships no secret of its own. A
*generation counter* settles races: if you log out (or restart login) while
an older login is still finishing, the older attempt notices its number is
stale and cleans up after itself instead of resurrecting a dead session.
Only the trusted sidebar window may even ask — main checks the exact sender
frame before answering.

> **Concepts:** OAuth 2.0 Device Flow, secret isolation across a trust
> boundary, and race handling via generation counters (optimistic
> concurrency for auth state).

---

## What's on your disk (and how deletion really deletes)

Everything lives in the app's private `userData` folder:

```
userData/
├─ sessions/               copilot chats (current.json + one file per archive)
├─ operator-sessions/      operator task history (isolated from chats)
├─ config.json             non-secret settings (URLs, model names)
├─ gateway-key.enc         provider API key      — encrypted
├─ openrouter/gemini-key.enc      free keys — encrypted
├─ operator-config.json + operator-provider-key-*.enc
└─ github-token.enc        GitHub access token   — encrypted
```

Two habits keep this safe:

```
  WRITE (every session change)
    encode a snapshot NOW (later edits can't corrupt it)
      └─► queue on the write chain (one write at a time, in order)
            └─► write current.json.tmp  ──► atomic rename over current.json
                (a crash mid-save can never leave half a conversation)

  DELETE (operator history)
    ① tombstone matching memories      ② stopAndWait — loop goes quiet
    ③ detach a matching active session ④ file removal via the same queue
    ⑤ filesystem failures propagate — deletion never silently "succeeds"
```

> **Concepts:** write serialization (a single-writer queue), atomic writes
> via rename, crash safety, and ordered shutdown — quiesce before you delete.

---

## How we know the chauffeur is safe (deterministic evals)

You can't unit-test "drive to the shops" against the real internet — it's
different every day. So `npm run eval:operator` runs the *production* agent
loop in a wind tunnel:

```
  scripted perception ─┐                            frozen clock + IDs
  scripted reasoning ──┼──► REAL AgentLoop ──► REAL SessionManager
  scripted safety ─────┤         │
  scripted executor ───┘         ▼
                          6 scenarios: clean success · self-correction
                          after 3 failures · reasoning-failure retry ·
                          budget exhaustion · confirmation · safety
                          block (zero executor calls)
                                 │
                                 ▼
                          byte-identical JSON report
                          artifacts/operator-evals/latest.json
                          (goal success and guardrail rates counted
                           separately; no Electron, browser, network,
                           keys, or real input anywhere)
```

Same inputs, same outputs, every run — a behavior change in the loop shows up
as a diff.

> **Concepts:** deterministic (hermetic) testing, dependency injection —
> side effects live behind seams you can script, and guardrail tests that
> assert what must *never* happen.

---

## Glossary

- **Main / renderer / preload** = back office, front desks, and the service
  hatch between them.
- **Session / summary** = the conversation and its running meeting-minutes.
- **Provider** = an AI endpoint the app can call (yours, hosted, or local).
- **Fallback chain** = the ordered list of providers tried until one answers.
- **State machine** = a system that is always in exactly one named state, with
  fixed rules for moving between states.
- **Fail-closed** = when in doubt, block — the safe answer is "no".
- **Atomic write** = write to a temp file, then rename; never half-saved.
- **Tombstone** = a "this id is dead" marker that outlives the data it buries.
- **Device Flow** = sign-in where you approve a short code in your own
  browser, so the app never touches your password.
