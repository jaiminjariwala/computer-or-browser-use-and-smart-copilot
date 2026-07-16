import { builtinModules } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/** Match electron-vite's built-in main/preload externals plus app-specific ones. */
const nodeExternals = [
    'electron',
    /^electron\/.+/,
    ...builtinModules.flatMap((m) => [m, `node:${m}`])
]

export default defineConfig({
    main: {
        // GitHub OAuth client ids are public identifiers. Embed the value used
        // for this build while still allowing a runtime environment override.
        define: {
            __GITHUB_OAUTH_CLIENT_ID__: JSON.stringify(
                process.env.GITHUB_OAUTH_CLIENT_ID ?? ''
            )
        },
        build: {
            outDir: 'out/main',
            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'src/main/index.ts')
                },
                output: {
                    format: 'cjs',
                    entryFileNames: '[name].js',
                    chunkFileNames: '[name]-[hash].js'
                },
                // Playwright backs the (optional) sandbox-browser operator
                // environment and is loaded lazily only when that backend
                // starts; keep it external so it is never bundled into main.
                // Must include electron-vite's default externals too — setting
                // `external` here replaces (not merges) the preset list.
                external: ['playwright', ...nodeExternals]
            }
        },
        resolve: {
            alias: {
                '@shared': resolve(__dirname, 'src/shared'),
                '@op-shared': resolve(__dirname, 'src/main/operator/shared')
            }
        }
    },
    preload: {
        build: {
            outDir: 'out/preload',
            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'src/preload/index.ts')
                },
                output: {
                    format: 'cjs',
                    entryFileNames: '[name].js',
                    chunkFileNames: '[name]-[hash].js'
                },
                external: nodeExternals
            }
        },
        resolve: {
            alias: {
                '@shared': resolve(__dirname, 'src/shared'),
                '@op-shared': resolve(__dirname, 'src/main/operator/shared')
            }
        }
    },
    renderer: {
        root: 'src/renderer',
        // Emit workers as ES modules. transformers.js (voice + the on-device
        // SmolVLM fallback) runs ONNX Runtime, which uses dynamic import() to
        // load its wasm/webgpu backend. Chromium FORBIDS dynamic import() in
        // classic (IIFE) workers, so those models silently fail to load there.
        // Module workers allow it. (In dev the renderer is served over http, so
        // module workers load fine; a packaged file:// build should serve the
        // renderer via a custom protocol so module workers keep working.)
        worker: {
            format: 'es'
        },
        build: {
            outDir: 'out/renderer',
            rollupOptions: {
                input: {
                    sidebar: resolve(__dirname, 'src/renderer/sidebar/index.html'),
                    overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
                    pencil: resolve(__dirname, 'src/renderer/pencil/index.html'),
                    // The operator "agent in control" overlay (Control_Indicator).
                    indicator: resolve(__dirname, 'src/renderer/indicator/index.html')
                }
            }
        },
        resolve: {
            alias: {
                '@shared': resolve(__dirname, 'src/shared'),
                '@op-shared': resolve(__dirname, 'src/main/operator/shared')
            }
        },
        plugins: [react()]
    }
})
