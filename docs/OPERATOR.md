# Operator engine

"Computer or Browser Use" turns the app from an advisor into an actor. You give
it a goal; it observes the selected environment, chooses one action, passes that
action through a safety gate, executes it, and observes again.

The engine lives under `src/main/operator/`. See [Merge notes](./MERGE-NOTES.md)
for how it remains isolated from the Smart Copilot engine.

## The core loop: perceive -> reason -> act

```
        ┌──────────────────────────────────────────────┐
        │                                               │
        v                                               │
   ┌─────────┐  observation   ┌──────────┐  one action │
   │ PERCEIVE│ ───────────────►│  REASON  │────────────►│
   └─────────┘                └────┬─────┘             │
        ▲                          │                    │
        │                   ┌──────▼──────┐             │
        │                   │ SAFETY GATE │             │
        │                   └──────┬──────┘             │
        │                          │ approved            │
        │                    ┌─────▼─────┐              │
        └────────────────────│  EXECUTE  │──────────────┘
             fresh state     └───────────┘
```

Every reasoning turn is appended to the trajectory with its observation,
rationale, chosen action (when there is one), result, model, token usage, and any
safety event. The activity UI renders a privacy-aware view of that audit record.

## Loop states and reliability

```
  idle
   │ start(goal)
   ▼
  perceiving ──► reasoning ──┬──► acting ──► perceiving
                             ├──► awaiting-confirmation ──► acting / continue
                             ├──► awaiting-help ──► perceiving
                             └──► completed | failed | budget-exhausted
  paused
  stopped
```

- **completed** — the agent decided the goal is done.
- **failed** — reasoning retries were exhausted or progress detection found it
  irrecoverably stuck.
- **budget-exhausted** — the next reasoning step was blocked because the configured
  budget had already been reached.
- **paused** — capture or another recoverable precondition failed.
- **stopped** — the user stopped the run or triggered Emergency Stop.

A failed action is recorded and followed by a fresh observation. The next
reasoning request gets a short corrective hint rather than blindly repeating the
same attempt. Unparseable reasoning can retry up to the loop's bounded retry
limit, while repeated ineffective actions trigger fail-fast progress detection.

## Autonomy and the safety gate

```
  Manual        confirm every action
  Supervised    confirm high-risk actions
  Autonomous    run allowed actions without confirmation
```

Every proposed action goes through the same fail-closed gate. It checks the
active session, legal loop state, emergency-stop state, control indicator,
permissions, typed action shape, step budget, and confirmation requirement. The
executor is unreachable unless the gate returns `allow`.

## Environments

The loop owns one `EnvironmentRouter`; the selected backend is fixed for the
session.

```
                     ┌────────────────────────┐
                     │   EnvironmentRouter    │
                     └───────────┬────────────┘
                         ┌───────┴────────┐
                         ▼                ▼
              ┌──────────────────┐  ┌──────────────────┐
              │ Browser Use      │  │ Compute Use     │
              │ Playwright       │  │ local macOS     │
              │ Chromium + DOM   │  │ screen + input  │
              └──────────────────┘  └──────────────────┘
```

- **Browser Use (`browser`)** launches a visible Playwright Chromium instance.
  It reads page text and interactive DOM controls, requires no macOS Screen
  Recording or Accessibility permission, and reports whether each action used
  structured DOM/API control or a coordinate fallback.
- **Compute Use (`local`)** observes and controls the real Mac. It requires Screen
  Recording and Accessibility permission.
- A **container desktop (`container-desktop`)** backend remains available in the
  service layer for isolated Linux/noVNC experiments; the current sidebar exposes
  Browser Use and Compute Use.

## DOM-first browser operation

Browser observations are text-first: title, URL, visible page text, interactive
controls, and bounded tab metadata are sent to reasoning. The visible Chromium
window is for the user to watch; the reasoning request does not need to attach a
browser screenshot.

Coordinates can still be proposed, but nearby clicks snap to real interactive
elements. A result records `api` when a DOM-aware path was used and `vision` when
raw coordinates were necessary.

### Multi-tab workflows

Existing typed `key` actions implement browser chrome operations without
expanding the cross-environment action union:

- open and close tabs;
- move to the next or previous tab;
- select a numbered tab (including the last tab shortcut);
- promote newly opened popup tabs to the active tab;
- recover to another open tab when the active one closes.

Each observation includes at most eight tab summaries plus the active-tab index,
so the model can compare sources without receiving unbounded browser history.
Every tab URL is reduced to its origin (or a non-network scheme marker), omitting
credentials, paths, query strings, and fragments. Cmd/Ctrl+Shift+`[` and `]`
switch tabs, leaving the ordinary Back and Forward shortcuts untouched. Each
observation is also bound to the exact internally selected Playwright `Page`
and a monotonic tab-lifecycle generation. Popup creation, popup closure, and
agent-driven tab selection invalidate that generation, including a popup that
opens and closes before execution, so stale context cannot be resurrected.
Chromium does not reliably expose a person clicking between already-open tabs
through Playwright visibility/focus state. The environment therefore brings the
bound page forward immediately before capture and execution as a best-effort
watchability measure, but does not claim it can atomically lock the foreground.
The enforceable invariant is exact-Page targeting: even if the user switches
during an asynchronous action, Playwright does not redirect it into the newly
visible tab.

### Focused fields and form safety

Ordinary text fills the focused editable DOM element through Playwright. URL-like
text navigates the active tab directly. Before Enter, a submit-button click, or a
submit-button double-click, the environment resolves native form ownership
through `control.form` (including external `form="id"` controls) and calls HTML
`checkValidity()`. Enter is checked only when the focused control can actually
trigger implicit submission, and `noValidate` / `formNoValidate` are honored.
If required fields are invalid, it calls `reportValidity()`, records a failed
action with up to four field labels, and does not submit.

This is a deterministic browser safety check, not a promise that every custom
JavaScript form or business rule can be inferred. Confirmation and user review
remain important for consequential submissions.

## Memory without trajectory replay

The active trajectory is rebuilt from an allowlist of static successful-action
categories, capped at 12 in-session items. It never summarizes model rationales,
typed values, coordinates, executor prose, or completion prose. For a new goal,
`SessionMemory` may recall related **completed** sessions from local storage:

- at most 24 recent archive bodies are decoded for candidate metadata; filenames
  are ranked with lightweight filesystem timestamps first;
- at most 3 related sessions are injected;
- at most 6 successful sub-steps are retained per recalled session;
- unrelated, failed, paused, or stopped sessions are excluded.

Local relevance uses numeric token fingerprints rather than retaining another
copy of the raw prior goal. Provider-facing memories use the generic label
`Related completed task`. Projection excludes screenshots, observations,
coordinates, typed values, rationales, completion prose, legacy free-form
summaries, and full trajectories. Recalled text is explicitly marked as untrusted
historical context; the current goal and observation remain authoritative.
Missing or corrupt archives fail empty. Deletion immediately tombstones matching
memories, waits for in-flight loop work to quiesce, detaches a matching active
session, serializes archive/current-file removal behind queued writes, propagates
filesystem failures, and invalidates cached or already-loading recall.

## Reusable task templates

The sidebar includes three editable starters: research across tabs, compare
options, and fill a form safely. It keeps up to five recent goals in renderer
`sessionStorage`, saves only after a task starts successfully, and skips goals
matching common sensitive markers. Selecting a template sets its recommended
environment and fills the composer, but never starts the task automatically.
Deleting operator history clears the recent list and removes the retired
persistent-storage key.

## Privacy-aware activity explanations

The live activity list shows semantic actions, result state, a bounded failure
category, and DOM/API versus Vision mode. It deliberately hides model rationales,
executor reasons, typed values, coordinates, and arbitrary key sequences. Failed
and blocked steps use a distinct visual state instead of looking completed.
Confirmation dialogs use a separate ephemeral disclosure: exact key chords,
pointer coordinates, drag endpoints, scroll deltas, and wait durations are shown;
typed values remain hidden with only their character count. Raw model rationale is
not used as the approval description. Help questions pass through the shared
secret/identifier sanitizer before entering chat.

## Deterministic AgentLoop evaluations

Run the production loop headlessly without Electron, a browser, network access,
credentials, application-session persistence, or real input. The CLI writes only
the deterministic evaluation report after execution:

```bash
npm run eval:operator
```

The harness uses the real `createAgentLoop` and in-memory `SessionManager` while
scripting only perception, reasoning, safety, and execution. Deterministic clocks,
IDs, and the report timestamp make the JSON byte-repeatable. Six scenarios cover:

1. straight-line goal completion;
2. three consecutive executor failures, production `SELF-CORRECTION` guidance,
   and a successful changed approach;
3. a routed reasoning failure followed by an actual loop retry;
4. step-budget exhaustion before an extra action;
5. confirmation approval before goal-satisfying execution;
6. fail-closed safety blocking with zero executor calls.

The four goal scenarios require an exact expected action to produce an
independent scripted-world state transition plus a separate completion signal.
A semantically different action cannot satisfy the oracle merely by occupying the
same script position. The two guardrails instead pass by reaching their expected
safe state; their efficiency is `null` / `n/a` and does not lower the goal-only
average. Proposed, executed, failed, and blocked actions are separate, as are
reasoning failures and failures that were actually retried.

The console prints goal success and guardrail pass rates separately. The CLI
writes a gitignored JSON report to `artifacts/operator-evals/latest.json` with
scenario assertions, final and terminal states, deterministic duration, token
usage, estimated cost, and goal-only efficiency.

## Wiring (main process)

```
  createOperatorServices({ getHostWindow: () => sidebar })
        │  builds + wires:
        │    EnvironmentRouter ─┐
        │    Provider chain ────┤
        │    Safety gate ───────┼─► AgentLoop ─► op:* IPC ─► sidebar
        │    SessionManager ────┤
        │    SessionMemory ─────┘
        ▼
  createStartGoalHandler(services)
        ▼
  wireOperatorIpc(services, handleStartGoal)
```

The start gate rejects an empty goal, unavailable environment, missing provider
configuration, unavailable emergency-stop path, or missing local-Mac
permissions before the run begins. See [Safety model](./SAFETY.md) and
[IPC channels](./IPC-CHANNELS.md) for the detailed contracts.
