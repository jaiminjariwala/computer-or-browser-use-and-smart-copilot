# Operator engine

"Computer or Browser Use" turns the app from an advisor (Smart Copilot) into an
actor. You give it a
goal, it completes the goal on its own by looking at a screen, deciding on one
action, doing it, and looking again. This follows the common computer-use agent
shape: perceive the screen, choose one action, execute it, then observe again.

The engine lives under `src/main/operator/` and was merged in from a separate
project. For how that merge is kept isolated, see [Merge notes](./MERGE-NOTES.md).

## The core idea: perceive -> reason -> act

The agent runs a loop. Each turn through the loop is one step.

```
        ┌──────────────────────────────────────────────┐
        │                                               │
        v                                               │
   ┌─────────┐   screenshot    ┌──────────┐  one action │
   │ PERCEIVE│ ───(+DOM hints)─►│  REASON  │────────────►│
   │ capture │                 │  model   │             │
   └─────────┘                 └────┬─────┘             │
        ▲                           │                   │
        │                           │ proposes          │
        │                    ┌──────▼──────┐            │
        │                    │ SAFETY GATE │            │
        │                    └──────┬──────┘            │
        │                           │ approved          │
        │                     ┌─────▼─────┐             │
        └─────── act ─────────│  EXECUTE  │─────────────┘
           new screen state   │  action   │
                              └───────────┘
```

Every step is recorded, in order, as a trajectory: what it saw, why it decided
what it did, the action, and the result. That trajectory is what streams into
the chat as the run progresses.

## Loop states

The loop is a small state machine. You mostly see the busy states (perceiving,
reasoning, acting) as the pending dots, and the terminal states as the final
outcome.

```
  idle
   │ start(goal)
   ▼
  perceiving ──► reasoning ──┬──► acting ──► perceiving  (continue)
                             │
                             ├──► awaiting-confirmation ──► acting / stopped
                             │        (Manual / Supervised)
                             │
                             ├──► awaiting-help ──► perceiving  (you answered)
                             │
                             └──► completed | failed | budget-exhausted
  paused  (you paused)
  stopped (Emergency_Stop, or you stopped)
```

- **completed** the agent decided the goal is done.
- **failed** it could not proceed.
- **budget-exhausted** it hit the step budget you set.
- **stopped** you hit Emergency Stop or Stop.

## Autonomy levels

You pick how much freedom the agent has from the header dropdown.

```
  Manual        confirm EVERY action before it runs
  Supervised    confirm only high-risk actions; do the rest automatically
  Autonomous    no confirmation at all; fully automatic
```

In Manual and Supervised, a confirmation card appears inline in the chat with the
proposed action and a short rationale. Approve or Decline. In Autonomous it just
goes, which is the smoothest to watch but the one to be most careful with.

## Environments: where it acts

The loop drives one **Environment** interface. Two backends implement it, and you
choose per task.

```
                     ┌────────────────────────┐
                     │   EnvironmentRouter    │  (forwards to the active one)
                     └───────────┬────────────┘
              ┌──────────────────┴──────────────────┐
              ▼                                      ▼
   ┌────────────────────┐               ┌──────────────────────────┐
   │  "My Mac" (local)  │               │ "Sandboxed browser"      │
   │                    │               │ (container-desktop)      │
   │ real macOS desktop │               │ Docker Linux + Chromium  │
   │ needs Screen Rec + │               │ live noVNC view, needs   │
   │ Accessibility      │               │ no macOS permissions     │
   └────────────────────┘               └──────────────────────────┘
```

The same loop, safety gate, autonomy rules, step budget, trajectory, and
Emergency Stop drive either one. The loop does not know which backend it is on.
The system prompt is environment-aware, so the model uses browser conventions in
the sandbox and macOS conventions on the Mac.

> An earlier third backend (a headless Playwright browser) was removed. Only the
> sandboxed Linux desktop and the local Mac remain.

## The typed Action space

The model cannot do anything outside this fixed set. Anything else is rejected
before it reaches the executor.

```
  screenshot                 look again
  mouse_move   {x, y}        move the cursor
  left_click   {x, y}        click
  right_click  {x, y}        context click
  double_click {x, y}        double click
  drag         {from, to}    press, move, release
  type         "text"        type text
  key          [keys]        press a key combo
  scroll       {x, y, dx,dy} scroll
  wait         ms            pause
```

A tolerant parser sits in front of this. Models emit coordinates and keys in
slightly different shapes (an object, an array, a bare string, native aliases
like triple_click). The parser normalizes those into the space above so a valid
intent is not thrown away over formatting.

## Hybrid perception (fewer vision tokens)

Instead of relying on the screenshot alone, the sandboxed browser also reports
its interactive elements (links, buttons, fields) with on-screen coordinates,
read from the page over the browser's dev protocol. Those get folded into the
prompt as structured text.

```
   screenshot  ─────────────┐
                            ├──► prompt to the model
   interactive elements  ───┘     (image + a short list of clickable
   (role, label, x/y)             elements in screen coordinates)
```

The upside is the model leans on cheap structured hints for "where is the search
box" rather than burning vision tokens to find it, and clicks land more reliably.

## What you see in the chat

- Each step's rationale plus the action it took ("Clicked at (640, 380)").
- Failures annotated on the step ("blocked", "rejected", with a reason).
- Confirmation cards when autonomy requires your approval.
- Questions from the agent when it needs guidance; your answer becomes guidance
  and the loop resumes.
- For the sandboxed browser, a separate live desktop window (noVNC) so you can
  watch the cursor glide and click on its own.

## Wiring (main process)

```
  createOperatorServices({ getHostWindow: () => sidebar })
        │  builds + wires:
        │    Perception ─┐
        │    Reasoning ──┤ (provider chain rebuilt per step from config)
        │    Safety  ────┼─► AgentLoop ─► emitters ─► op:* IPC ─► sidebar UI
        │    Executor ───┤
        │    Session ────┘
        ▼
  createStartGoalHandler(services)   the fail-closed start gate
        ▼
  wireOperatorIpc(services, handleStartGoal)   registers op:* channels
```

The start gate refuses to begin unless the goal is non-empty, credentials exist,
the Emergency Stop hotkey registered, and (for the Mac) permissions are granted.
Fail closed: if a precondition is missing, it surfaces a specific error instead
of half-starting.

See [Safety model](./SAFETY.md) for the gate and kill switch in detail, and
[IPC channels](./IPC-CHANNELS.md) for the `op:*` channel map.
