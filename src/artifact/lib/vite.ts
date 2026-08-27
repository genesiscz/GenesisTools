import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import type { Plugin, PluginOption } from "vite";

/** GenesisTools repo root (this file lives at src/artifact/lib/). */
export const REPO_ROOT = resolve(__dirname, "../../..");

/** Runtime assets shipped with the tool (Tailwind entry CSS, mount shell). */
export const RUNTIME_DIR = resolve(__dirname, "../runtime");

/**
 * Resolve bare imports (react, react-dom, …) from the GenesisTools repo when the
 * served directory has no node_modules of its own. Normal resolution is tried
 * first, so a dashboard folder that DOES carry its own dependencies keeps them
 * (and keeps a single React instance, since everything then resolves there).
 */
export function resolveFromRepo(): Plugin {
    return {
        name: "artifact:resolve-from-repo",
        enforce: "pre",
        async resolveId(source, importer, options) {
            if (
                !source ||
                source.startsWith(".") ||
                source.startsWith("/") ||
                source.startsWith("#") ||
                source.startsWith("\0") ||
                source.includes(":")
            ) {
                return null;
            }

            const local = await this.resolve(source, importer, { ...options, skipSelf: true });

            if (local) {
                return local;
            }

            return this.resolve(source, join(REPO_ROOT, "_virtual.ts"), { ...options, skipSelf: true });
        },
    };
}

/** Shared plugin set for serve and build. */
export function basePlugins(): PluginOption[] {
    return [resolveFromRepo(), tailwindcss(), viteReact()];
}

/**
 * Shared resolve config. Every served/built artifact gets, with no install and
 * no tsconfig in its folder:
 * - `@artifact/kit` — the component kit (Tabs, MdViewer, Timeline, Simulator, …)
 * - `@genesistools/…` — absolute imports into this repo (`@genesistools/src/utils/format`)
 * - `@genesiscz/utils/…` — the repo's shared-utils package, same specifier the repo uses
 */
export function baseResolve(): { alias: Record<string, string> } {
    return {
        alias: {
            "@artifact/kit": join(RUNTIME_DIR, "kit", "index.ts"),
            "@genesistools": REPO_ROOT,
            "@genesiscz/utils": join(REPO_ROOT, "src", "utils"),
            // Core runtime deps pinned to the repo's node_modules so the served
            // dir needs none. They MUST also go through optimizeDeps (below):
            // react ships CJS, and only the prebundle gives it ESM named exports.
            react: join(REPO_ROOT, "node_modules", "react"),
            "react-dom": join(REPO_ROOT, "node_modules", "react-dom"),
            marked: join(REPO_ROOT, "node_modules", "marked"),
        },
    };
}

/**
 * Dev-server prebundle list: CJS deps served to the browser need Vite's
 * optimizer interop (named exports). Anything resolved by resolveFromRepo()
 * outside this list must be ESM-shipping to work in dev.
 */
export function baseOptimizeDeps(): { include: string[] } {
    return {
        include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client", "marked"],
    };
}

/**
 * Per-served-dir Vite cache under the REPO's node_modules, never under the
 * served directory: the served dir is user content (often a vault folder) and
 * must not grow a node_modules/.vite of its own.
 */
export function cacheDirFor(dir: string): string {
    const slug = createHash("sha1").update(dir).digest("hex").slice(0, 12);

    return join(REPO_ROOT, "node_modules", ".vite-cache", `artifact-${slug}`);
}
