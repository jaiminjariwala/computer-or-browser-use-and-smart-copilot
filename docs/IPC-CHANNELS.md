# IPC channels

Renderers never touch Node or system APIs. They call a typed preload bridge,
which forwards to `ipcMain` handlers in the main process. There are two bridges
on `window`, one per engine, and their channels never overlap.

```
   renderer                preload bridge            main process
   --------                --------------            ------------
   window.glass.*    ──►   ipcRenderer.invoke  ──►   ipcMain.handle (chat/session/config/capture)
   window.operator.* ──►   ipcRenderer.invoke  ──►   ipcMain.handle (op:*)

   window.glass.on*    ◄── ipcRenderer.on      ◄──   webContents.send (turn/summary/error ...)
   window.operator.on* ◄── ipcRenderer.on      ◄──   webContents.send (op:* events)
```

The rule that keeps them apart: every operator channel is prefixed with `op:`.
That is what lets both engines register handlers in the same process without
Electron throwing "second handler" errors, and lets both sets of events land in
the same window without one engine's listeners firing on the other's events.

## Copilot channels (window.glass)

### Renderer -> main (request/response)

| Channel | Purpose |
| --- | --- |
| `chat:send` | Send a typed message. |
| `chat:send-captures` | Send staged screenshots/images (+ optional text) as one multi-image message. |
| `chat:fallback-result` | Report the on-device fallback model's answer (or null when it failed). |
| `capture:trigger` | Begin a region capture. |
| `capture:region` / `capture:cancel` | Rectangle chosen / capture cancelled. |
| `session:new` / `session:get` / `session:list` / `session:open` / `session:delete` | Conversation management. |
| `models:list` | List gateway models. |
| `audio:transcribe` | Speech-to-text for a recorded clip. |
| `config:get-status` / `config:save` | Gateway + fallback settings (owned by config.ts). |
| `window:set-pinned` | Pin/unpin the window on top (header toggle). |
| `github-auth:status` / `github-auth:start` / `github-auth:logout` | Read non-secret status, begin GitHub Device Flow, or delete the encrypted token. |

### Main -> renderer (events)

Copilot events include the originals (`turn:appended`, `request:pending`,
`error:show`, `session:state`, `summary:state`, `credentials:required`) plus:

| Channel | Purpose |
| --- | --- |
| `capture:staged` | A freshly captured shot to add to the carousel above the input. |
| `chat:fallback` | Ask the renderer's on-device model to answer (carries the full context) when the gateway chain failed. |
| `github-auth:changed` | Non-secret Device Flow status and minimal GitHub identity; never a token. |

### Main -> renderer (events)

| Channel | Purpose |
| --- | --- |
| `turn:appended` | A new turn to render. |
| `request:pending` | Toggle the thinking indicator. |
| `error:show` | Surface an error. |
| `session:state` | Replace the active session view. |
| `summary:state` | Update the goal/step tracker. |
| `credentials:required` | Prompt to configure the gateway. |

## Operator channels (window.operator)

### Renderer -> main (request/response)

| Channel | Purpose |
| --- | --- |
| `op:goal:start` | Start a task: goal, autonomy, step budget, environment. |
| `op:session:pause` / `op:session:resume` / `op:session:stop` | Loop control. |
| `op:confirm:action` | Approve or decline a proposed action. |
| `op:help:answer` | Answer a question the agent asked (becomes guidance). |
| `op:session:get` / `op:session:list` / `op:session:open` | Operator task history. |
| `op:config:get-status` / `op:config:save` | Operator provider config. |
| `op:providers:get` / `op:providers:save` / `op:providers:test` | Provider chain management. |
| `op:perm:get` | macOS permission snapshot. |
| `op:emergency:stop` | On-screen kill switch (fallback). |

### Main -> renderer (events)

| Channel | Purpose |
| --- | --- |
| `op:state:changed` | Loop state view (drives pending + terminal handling). |
| `op:trajectory:appended` | One perceive -> reason -> act step, rendered as a turn. |
| `op:confirmation:required` | A proposed action needs your approval. |
| `op:help:required` | A question from the agent. |
| `op:indicator:show` / `op:indicator:hide` | Toggle the "agent in control" overlay. |
| `op:error:show` | Surface an operator error. |
| `op:permission:changed` | Permission snapshot changed. |
| `op:credentials:required` | Operator has no usable provider. |

## What is deliberately NOT a channel

There is no channel for capture, reasoning, or input synthesis on either bridge.
Those privileged capabilities live entirely in the main process and can never be
invoked directly from a renderer. A renderer can ask to start or steer a task and
subscribe to what happens; it cannot reach in and drive the mouse itself.
