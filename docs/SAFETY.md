# Safety model

An agent that can move the mouse and type needs hard guardrails. Operator mode is
built so that "the agent acts invisibly or without a way to stop it" is
structurally impossible, not just discouraged.

Copilot mode has no safety gate because it never acts; it only advises. Everything
below is about operator mode.

## The single execution chokepoint

Every proposed action flows through one gate before it can run. There is no other
path to the executor. If the gate does not say yes, nothing happens.

```
   model proposes an action
            │
            ▼
   ┌──────────────────┐    no    ┌──────────────────────┐
   │   SAFETY GATE    │ ───────► │ blocked / rejected    │
   │  (fail-closed)   │          │ recorded, loop pauses │
   └────────┬─────────┘          └──────────────────────┘
            │ yes
            ▼
        EXECUTE
```

The gate checks all of these together, and fails closed if any is off:

```
  [ ] a session is actually active (an explicit user start)
  [ ] Emergency Stop is not active
  [ ] the "agent in control" indicator is actually displayed
  [ ] permissions hold (for the Mac backend)
  [ ] the step budget is not exhausted
  [ ] the autonomy rule for this action is satisfied
      (Manual: confirmed; Supervised: confirmed if high-risk; Autonomous: ok)
```

## Autonomy levels

```
  Manual        confirm EVERY action
  Supervised    confirm only HIGH-RISK actions, auto-run the rest
  Autonomous    no confirmation at all
```

High-risk actions are classified before they run (things with larger or harder to
undo consequences). In Manual and Supervised, a confirmation card appears inline
in the chat; Approve routes the action back through the gate, Decline records the
refusal and the loop moves on or stops.

## The kill switch (Emergency Stop)

There are two ways to stop the agent instantly:

```
   global hotkey  Cmd+Shift+Esc   ──┐
                                    ├──► activateEmergencyStop()
   on-screen button (overlay)   ────┘        │
                                             ├─ set stopped flag (gate blocks)
                                             ├─ cancel any in-flight action
                                             ├─ halt the loop
                                             ├─ drop out of "in control"
                                             └─ record the stop in the trajectory
```

The hotkey is global, so it fires even when another app has focus. If it cannot
be registered at launch, the app refuses to start a task (Req: no reliable kill
switch, no run) but keeps the on-screen button as a fallback.

## The "agent in control" indicator

While the agent is acting, a transparent, click-through overlay is shown across
the screen with an "Agent in control" badge and an Emergency Stop button. It is
tied in lockstep to the in-control flag.

```
   agent starts acting   ─►  indicator SHOWN   (setInControl true)
   agent stops/pauses    ─►  indicator HIDDEN  (setInControl false)

   if the indicator cannot be displayed while acting:
        ─►  loop halts, "indicator-unavailable" surfaced, gate blocks
```

This is why the gate checks "indicator actually displayed": if we cannot show the
user that the agent is in control, the agent is not allowed to act.

## Fail-closed start gate

Starting a task is itself gated. The loop only leaves idle when the full set of
preconditions holds at once:

```
   non-empty goal
   + Emergency Stop hotkey registered
   + credentials / provider present
   + permissions granted (Mac backend only; sandbox needs none)
   + indicator can be displayed
   ────────────────────────────────
   = loop.start()
```

If any precondition is missing, the gate returns a specific, actionable error
(for example "configure a provider" or "grant Screen Recording") rather than
starting halfway.

## Isolation from your real machine

The default operator environment is the **Sandboxed browser**: a Docker Linux
desktop that never touches your files, your desktop, or your other apps. If you
choose **My Mac** instead, the agent drives your real desktop and the macOS
Screen Recording and Accessibility permissions come into play, plus every action
still passes through the same gate and kill switch.
