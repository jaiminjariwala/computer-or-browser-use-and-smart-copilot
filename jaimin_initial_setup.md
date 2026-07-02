# Jaimin's setup notes (short)

Personal cheat sheet: how to run this on a new machine and how to hand it to
someone else. macOS only.

## 1. Run it on my machine (dev)

```bash
cd click-copilot
npm install
npm run dev        # launches the app with hot reload
```

Then in the app: open **Settings** and add a gateway key (or just use it as-is,
the on-device fallback answers without any key). Grant **Screen Recording** and
**Microphone** in System Settings > Privacy & Security when asked.

Handy commands:

```bash
npm run typecheck  # TypeScript check
npm test           # Vitest suite
npm run build      # production bundle (out/)
```

## 2. Keys (optional but better answers)

All optional. Without any key, copilot mode still works via on-device SmolVLM.

- Primary provider: Settings > Gateway base URL, model, and API key. Use any
  OpenAI-compatible endpoint you control.
- Free fallbacks (paste once, used automatically): Settings > "Free fallback
  models" - OpenRouter (openrouter.ai/keys), Zhipu GLM (open.bigmodel.cn),
  Google Gemini (aistudio.google.com/apikey).

Chain order: primary provider -> your Ollama (if set) -> Gemini -> GLM ->
OpenRouter -> on-device SmolVLM. See docs/FALLBACK.md.

## 3. Operator mode (sandboxed browser)

Needs Docker via Colima (Docker Desktop is not required):

```bash
brew install colima docker
colima start
docker context use colima
cd operator-docker && docker build -t click-operator-desktop:latest .
```

"My Mac" operator mode instead needs macOS Screen Recording + Accessibility.

## 4. Give it to someone (build + share)

```bash
npm run dist       # builds release/*.dmg and *.zip (macOS)
```

Share the `.dmg`:

1. Push the repo to GitHub, create a **Release**, upload the `.dmg`.
2. Put that link (or the repo link) in the resume.

Because the build is unsigned (`electron-builder.yml` has `identity: null`),
the person must **right-click the app > Open** the first time (or run
`xattr -cr "/Applications/Click Copilot.app"`). To remove that friction, get an
Apple Developer ID ($99/yr), set a signing identity, and enable notarization in
`electron-builder.yml`.

Tip for a resume: link the GitHub repo + a short demo video (Loom/YouTube) so
non-Mac reviewers can see it work without downloading anything.

## 5. Files worth knowing

- `src/main/` - Electron main (capture, gateway, fallback chain, operator engine).
- `src/renderer/sidebar/` - the chat UI (App.tsx, Settings.tsx, models.ts).
- `src/main/operator/` - the vendored autonomous operator engine.
- `operator-docker/` - the sandboxed Linux desktop image.
- `docs/` - architecture, setup, fallback, IPC, safety, tech stack.
