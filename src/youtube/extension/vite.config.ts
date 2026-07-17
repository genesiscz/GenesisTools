import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import { env } from "../../utils/env.client";
// Relative + client-safe env facade so vite's config loader and rollup's dep
// scan both inline these without tsconfig path mapping (env.client pulls in no
// bare @app specifiers; json.ts imports only comment-json).
import { SafeJSON } from "../../utils/json";

const root = resolve(import.meta.dirname);
const dist = resolve(root, "../../../dist/extension");

function copyExtensionStaticAssets(): Plugin {
    return {
        name: "copy-extension-static-assets",
        async closeBundle() {
            await mkdir(dist, { recursive: true });
            await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
            await mkdir(resolve(dist, "icons"), { recursive: true });

            for (const name of ["icon16.png", "icon48.png", "icon128.png"]) {
                await copyFile(resolve(root, "icons", name), resolve(dist, "icons", name));
            }
        },
    };
}

const devReload = env.extension.isDevReload();

const shared: UserConfig = {
    root,
    plugins: [tailwindcss(), viteReact()],
    define: {
        __EXT_DEV_RELOAD__: SafeJSON.stringify(devReload),
    },
    resolve: {
        alias: {
            "@app": resolve(root, "../.."),
            "@ext": root,
            "@ui": resolve(root, "../../utils/ui"),
        },
    },
};

// Two-pass build: content-script MUST be a self-contained IIFE because Chrome
// MV3 content scripts don't support ES module imports. Background + popup
// happily use module chunks; keep them together to share code.
const target = env.extension.getBuildTarget() ?? "modules";

const configs: Record<string, UserConfig> = {
    modules: {
        ...shared,
        plugins: [...(shared.plugins ?? []), copyExtensionStaticAssets()],
        build: {
            outDir: dist,
            // emptyOutDir:false — the content-script pass writes its own file
            // to the same dir. If modules were to empty it, a runtime-only
            // rebuild (bg/popup change) would delete content-script.js and
            // Brave would refuse to load the extension. Manual `tools
            // youtube extension build` runs both passes so stale files get
            // overwritten there.
            emptyOutDir: false,
            rollupOptions: {
                input: {
                    background: resolve(root, "background.ts"),
                    popup: resolve(root, "popup/popup.html"),
                },
                output: {
                    entryFileNames: "[name].js",
                    chunkFileNames: "chunks/[name]-[hash].js",
                    assetFileNames: "assets/[name]-[hash][extname]",
                },
            },
        },
    },
    "content-script": {
        ...shared,
        // Vite `lib` mode skips the app-build `process.env.NODE_ENV` replace,
        // so React's internals reference `process.env` at runtime. Content
        // scripts run in a browser context with no `process` → replace here.
        define: {
            "process.env.NODE_ENV": SafeJSON.stringify("production"),
            __EXT_DEV_RELOAD__: SafeJSON.stringify(devReload),
        },
        // Chrome MV3 content-script loader rejects files containing chars it
        // reads as non-UTF-8 (e.g. U+FFFF from regex ranges, dozens of Latin-1
        // supplement chars in bundled HTML-entity tables): "Could not load
        // file 'content-script.js' for content script. It isn't UTF-8
        // encoded." Force esbuild-minify to escape all non-ASCII into \uXXXX
        // so the bundle is pure ASCII.
        esbuild: {
            charset: "ascii",
        },
        build: {
            outDir: dist,
            emptyOutDir: false,
            minify: "esbuild",
            lib: {
                entry: resolve(root, "content-script.ts"),
                name: "GenesisYtContentScript",
                formats: ["iife"],
                fileName: () => "content-script.js",
            },
            rollupOptions: {
                output: {
                    inlineDynamicImports: true,
                    assetFileNames: "assets/[name]-[hash][extname]",
                },
                plugins: [
                    {
                        name: "ascii-only-postprocess",
                        renderChunk(code) {
                            const escaped = code.replace(
                                /[-￿]/g,
                                (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
                            );
                            return { code: escaped, map: null };
                        },
                    },
                ],
            },
        },
    },
};

const config = configs[target];

if (!config) {
    throw new Error(`Unknown EXT_TARGET=${target}. Use 'modules' or 'content-script'.`);
}

export default defineConfig(config);
