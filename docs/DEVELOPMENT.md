# Development & packaging

## Commands

```bash
npm install              # install dependencies
npm run dev              # run in development (electron-vite)
npm run eval:operator    # deterministic AgentLoop scenarios + JSON report
npm test                 # run the existing Vitest suite once
npm run typecheck        # TypeScript type checking
npm run build            # production build into out/
npm run pack             # build an unpacked macOS app
npm run dist             # build macOS .dmg + .zip artifacts
```

Development mode is long-running. Start it manually in a terminal and stop it
with Ctrl+C when finished. The validation commands above terminate on their own.

## GitHub OAuth Device Flow

Create a GitHub OAuth App for this application, enable **Device Flow**, and use
only its public client ID. A client secret is not needed and must not be added to
the repository or renderer. GitHub's official flow setup is documented at
[Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

For development, supply the public id when starting the app:

```bash
GITHUB_OAUTH_CLIENT_ID=your_public_client_id npm run dev
```

For a distributable build, provide the same variable to `npm run build`; the
public id is embedded in the main-process bundle. A runtime environment value
still takes precedence. After authorization, only the Electron main process
handles the device/access tokens. The access token is encrypted with macOS
Keychain-backed `safeStorage` in `github-token.enc`; the preload bridge exposes
only status, the short user code, verification URL, and minimal account identity.

## Deterministic operator evaluations

`npm run eval:operator` exercises the production `createAgentLoop` and in-memory
`SessionManager` without launching Electron, Chromium, a provider, or an input
backend. Only the loop's injected perception, reasoning, safety, and executor
interfaces are scripted. IDs, time, and the report timestamp are fixed, so two
runs with the same code produce byte-identical JSON.

The suite currently covers four goal scenarios and two guardrails:

1. one goal-satisfying action followed by completion;
2. three consecutive executor failures, the real threshold-based
   `SELF-CORRECTION` guidance, a changed action, and completion;
3. a routed reasoning failure followed by an actual loop retry (this is not a
   provider-parser test);
4. step-budget exhaustion before an extra action reaches the executor;
5. explicit confirmation before goal-satisfying execution;
6. a fail-closed safety block that must never call the executor.

The command prints a readable table and writes the machine-readable report to:

```text
artifacts/operator-evals/latest.json
```

That directory is gitignored. Choose another path when a CI job or local tool
needs to retain a specific run:

```bash
npm run eval:operator -- --output artifacts/operator-evals/ci.json
```

Goal success is independent of the loop's completion state: an exact expected
action must first produce the scripted world-state transition, and reasoning must
separately emit a completion signal. A different action in the same script slot
cannot satisfy the oracle. This prevents both completion overclaims and
call-index-only false positives from counting as task success.

The JSON report includes:

- per-scenario assertions and overall suite pass rate;
- goal success and guardrail pass rates with separate denominators;
- final state, terminal state, and session status;
- proposed, executed, successful, failed, and safety-blocked action counts;
- reasoning failures separately from failures followed by a real retry;
- captures, executor calls, safety evaluations, confirmation counts, and whether
  the production self-correction hint reached a reasoning context;
- deterministic duration, token totals, estimated model cost, and efficiency.

Efficiency is computed only for goal scenarios. A budget-exhaustion or
safety-block guardrail has `null` efficiency and passes when it reaches the
intended safe state while proving that no forbidden action reached the executor.
This is why `scenario checks`, `goal success`, and `guardrail checks` are reported
separately.

## Recommended validation sequence

Before review or packaging, run:

```bash
npm run eval:operator
npm run typecheck
npm test
npm run build
git diff --check
```

The eval must report all scenario checks passing, TypeScript must report no
errors, the existing test suite must pass, and the production build must finish.
`git diff --check` catches whitespace errors in the final patch.

## Packaging (macOS)

Packaging uses [electron-builder](https://www.electron.build/) via
`electron-builder.yml`. The production build output (`out/`) is what gets
packaged; `package.json` `main` points at `out/main/index.js`.

```bash
npm run pack   # build + electron-builder --dir (unpacked .app, fast local check)
npm run dist   # build + electron-builder --mac (.dmg + .zip into release/)
```

Notes:

- Builds are **unsigned** by default (`mac.identity: null`) for personal/local
  use. Public distribution should use a Developer ID identity and notarization.
- Hardened Runtime is enabled with `build/entitlements.mac.plist`, including the
  microphone `audio-input` entitlement for voice dictation and the
  `com.apple.security.device.camera` entitlement for the in-app video recorder.
- `electron-builder.yml` declares both usage strings under `mac.extendInfo`:
  `NSCameraUsageDescription` (shown the first time the video recorder opens)
  and `NSMicrophoneUsageDescription` (covers voice dictation and, when allowed,
  the audio track of videos you record).

## Local stable-signing deploy loop

To keep the macOS Screen Recording grant from being lost on every rebuild, local
deploys are signed with the trusted self-signed certificate created by
`scripts/setup-signing.sh`. Keep the existing certificate name: changing the
signature causes macOS to request permission again.

```bash
APP="Computer or Browser Use and Smart Copilot"
npm run typecheck && npm test && npm run pack
codesign --force --deep --options runtime \
  --entitlements build/entitlements.mac.plist \
  --sign "Glass Local Signing" "release/mac-arm64/$APP.app"
pkill -x "$APP"; rm -rf "/Applications/$APP.app"
cp -R "release/mac-arm64/$APP.app" "/Applications/$APP.app"
open "/Applications/$APP.app"
```

Do **not** run `tccutil reset`; stable signing is what lets the permission grant
persist.

## Manual QA (macOS-specific)

These checks depend on the live window server, macOS permissions, browser UI, or
Spaces and therefore remain manual.

### 1. Capture shortcuts from another app

- [ ] With the app unfocused, press Cmd+Shift+D and select a region; the shot
  appears above the input.
- [ ] Cmd+Shift+F selects a window; Cmd+Shift+S captures the full screen.
- [ ] Esc during capture cancels without staging an image.

### 2. Permission grant and revocation

- [ ] Before Screen Recording is granted, capture shows enablement instructions.
- [ ] Grant it in System Settings; capture and local Compute Use work.
- [ ] Revoke it after a successful capture; the next local action fails closed and
  shows re-enable instructions.

### 3. Browser tabs and popup promotion

- [ ] Start Browser Use and ask it to open sources in separate tabs.
- [ ] New, close, next/previous, and numbered-tab shortcuts affect browser tabs,
  not page content.
- [ ] A popup/new tab becomes active and appears in the next tab digest.
- [ ] Closing the active tab promotes another open tab; an agent-issued close
  on the only tab leaves a usable blank page.
- [ ] Open and immediately close a popup before the next action; the old
  observation is rejected and the loop captures again.

### 4. Form filling and validation

- [ ] Focus an input and type through the agent; the field is replaced through
  DOM fill rather than leaking text into browser chrome.
- [ ] Attempt Enter and a submit-button click with an invalid required field; the
  action fails and the page does not submit.
- [ ] Correct the field and confirm a valid form can proceed under the selected
  autonomy policy.

### 5. Activity privacy

- [ ] Activity rows show semantic actions, failures, and API/Vision mode without
  typed values or raw coordinates.

### 6. Session memory

- [ ] Complete a task, then start a clearly related task and confirm a bounded
  successful-summary memory is available to reasoning.
- [ ] Unrelated or incomplete sessions are not recalled.
- [ ] Recalled context does not contain screenshots, raw observations,
  coordinates, or typed action values.

### 7. Video attachments and the camera recorder

- [ ] Attach an `.mp4`, `.mov`, and `.webm` via paperclip → **Files** (or
  drag&drop); each shows a playable preview card with "Sampling frames…", then
  its duration and sampled frame count (e.g. "0:42 · 11 AI frames").
- [ ] Paperclip → **Camera** opens the recorder; recording stops and attaches
  the video, which goes through the same sampling flow.
- [ ] With Microphone denied but Camera allowed, recording still works and
  produces a video-only file (the recorder retries camera-only).
- [ ] Pressing Send while a video is still extracting is blocked: the send
  button is disabled with a "Preparing video frames…" tooltip and an error
  explains the video is still being converted.
- [ ] Staging a third video is rejected with the "up to 2 videos" message; the
  first two stay staged.

### 8. Window and voice behavior

- [ ] Sidebar and capture overlay behave correctly across Spaces and full-screen
  apps.
- [ ] Tap the microphone, speak, and stop; text streams while recording and does
  not change after stop.
- [ ] After the initial model download, dictation works offline.

## Credentials and providers

See [AI gateway](./AI-GATEWAY.md). Configure an OpenAI-compatible primary
provider, a local endpoint, or one of the supported hosted fallback keys in
Settings.
