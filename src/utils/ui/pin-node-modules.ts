import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";

const NODE_MODULES = "/node_modules/";

function packageDirOf(importer: string): string | null {
    const file = normalizePath(importer.split("?")[0]);
    const at = file.lastIndexOf(NODE_MODULES);
    if (at === -1) {
        return null;
    }

    const [first, second] = file.slice(at + NODE_MODULES.length).split("/");
    const name = first.startsWith("@") ? `${first}/${second}` : first;

    return `${file.slice(0, at + NODE_MODULES.length)}${name}`;
}

/**
 * Vite plugin that pins ALL bare-module resolution to the dashboard's own
 * directory tree (walking up to its nearest `node_modules/`).
 *
 * Problem: When a dashboard's source lives in a git worktree, the worktree
 * has its own `node_modules/react` but TanStack Start (in the main repo's
 * `node_modules/`) loads `react-dom` from the *main* repo.  Two different
 * React instances → "Invalid hook call" crash during SSR.
 *
 * Fix: Resolve every bare import (`react`, `@tanstack/…`, etc.) from the
 * dashboard root, which walks up to the worktree's `node_modules/`.  This
 * guarantees a single copy of React regardless of where the importer lives.
 *
 * When not in a worktree this is a harmless no-op — the dashboard root and
 * the repo root share the same `node_modules/`.
 *
 * Exception: a dependency's OWN nested copy (`node_modules/<pkg>/node_modules/<dep>`)
 * wins. The package manager nests a copy exactly when the hoisted one has the wrong
 * version for that package (`@reduxjs/toolkit` needs redux 5 while the hoisted redux
 * is 4), so pinning it to the hoisted copy fails the build with MISSING_EXPORT.
 */
export function pinNodeModules(dashboardRoot: string): Plugin {
    return {
        name: "pin-node-modules-to-dashboard-root",
        enforce: "pre",
        async resolveId(
            source: string,
            importer: string | undefined,
            options: { isEntry: boolean; [key: string]: unknown }
        ) {
            if (
                !source ||
                !importer ||
                source.startsWith(".") ||
                source.startsWith("/") ||
                source.startsWith("#") ||
                source.includes(":") ||
                source.startsWith("@ui") ||
                source.startsWith("@app") ||
                source.startsWith("@genesiscz")
            ) {
                return null;
            }

            const packageDir = packageDirOf(importer);
            if (packageDir && existsSync(`${packageDir}/node_modules`)) {
                const own = await this.resolve(source, importer, { ...options, skipSelf: true });
                if (own && normalizePath(own.id).startsWith(`${packageDir}${NODE_MODULES}`)) {
                    return own;
                }
            }

            return this.resolve(source, resolve(dashboardRoot, "_virtual.ts"), { ...options, skipSelf: true });
        },
    };
}
