# Development & packaging

## Commands

```bash
npm install        # install dependencies
npm run dev        # run in development (electron-vite)
npm test           # run the Vitest suite
npm run typecheck  # TypeScript type checking
npm run build      # production build into out/
```

## Packaging (macOS)

Packaging uses [electron-builder](https://www.electron.build/) via
`electron-builder.yml`. The production build output (`out/`) is what gets
packaged; `package.json` `"main"` points at `out/main/index.js`.

```bash
npm run pack   # build + electron-builder --dir (unpacked .app, fast local check)
npm run dist   # build + electron-builder --mac (.dmg + .zip into release/)
```

Notes:
- Builds are **unsigned** by default (`mac.identity: null`) for personal/local
  use. For distribution, configure a Developer ID identity and notarization.
- Hardened Runtime is enabled with `build/entitlements.mac.plist` (includes the
  microphone `audio-input` entitlement for voice dictation).

## Local "stable signing" deploy loop

To keep the macOS Screen Recording grant from being lost on every rebuild, deploys
are signed with a trusted self-signed cert (`Glass Local Signing`, created by
`scripts/setup-signing.sh`). The cert name is left as-is on purpose — renaming
it would change the signature and force macOS to re-prompt for Screen Recording.
Typical loop:

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

Do **not** run `tccutil reset` — stable signing is what makes the permission
grant persist; resetting forces a re-grant.

## Manual QA (macOS-specific)

These depend on the live window server + TCC prompts + Spaces/full-screen, so
they can't be covered by the automated suite.

### 1. Capture shortcuts from another app
- [ ] With the app unfocused (e.g. Safari focused), press ⌘⇧D → native region crosshair; the shot lands as a thumbnail above the input.
- [ ] ⌘⇧F → window pick; ⌘⇧S → full screen. Each stages a thumbnail.
- [ ] Press Esc during a capture → nothing is staged (clean cancel).

### 2. Screen Recording permission: grant
- [ ] Before granting, trigger capture → instructions to enable it appear.
- [ ] Grant it in System Settings → Privacy & Security → Screen Recording → capture works.

### 3. Screen Recording permission: revocation
- [ ] Revoke after a successful capture → next capture detects it, skips, and shows re-grant steps.

### 4. Always-on-top across Spaces / full-screen
- [ ] Sidebar stays available when switching Spaces.
- [ ] Sidebar + Overlay appear above full-screen apps when summoned.

### 5. Voice dictation
- [ ] Tap mic, speak → words stream in; stop → no late change.
- [ ] First run downloads the model once (needs network); later runs work offline.

## Credentials / gateway

See [AI gateway](./AI-GATEWAY.md). Configure an OpenAI-compatible primary
provider, a local fallback such as Ollama, or any of the free hosted keys in
Settings.
