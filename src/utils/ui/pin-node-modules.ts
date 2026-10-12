import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";

const NODE_MODULES = "/node_modules/";
/** One copy for the whole page, whatever a dependency nests: two Reacts is the "Invalid hook call" this plugin stops. */
const SINGLETONS = ["react", "react-dom"];

function isSingleton(source: string): boolean {
    return SINGLETONS.some((name) => source === name || source.startsWith(`${name}/`));
}

/**
 * The package folders an importer inside `node_modules` sits in, outermost first:
 * `/r/node_modules/a/node_modules/b/x.js` is in `/r/node_modules/a` and `/r/node_modules/a/node_modules/b`.
 */
function packageDirsOf(importer: string): string[] {
    const file = normalizePath(importer.split("?")[0]);
    const dirs: string[] = [];
    let at = file.indexOf(NODE_MODULES);

    while (at !== -1) {
        const start = at + NODE_MODULES.length;
        const [first, second] = file.slice(start).split("/");
        const dir = `${file.slice(0, start)}${first.startsWith("@") ? `${first}/${second}` : first}`;
        dirs.push(dir);
        at = file.indexOf(NODE_MODULES, dir.length);
    }

    return dirs;
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
 * Exception: a nested copy (`node_modules/<pkg>/node_modules/<dep>`) wins for the code
 * inside `<pkg>`, nested packages included, as Node's own lookup lets it. The package
 * manager nests a copy exactly when the hoisted one has the wrong version for that
 * package (`@reduxjs/toolkit` needs redux 5 while the hoisted redux is 4), so pinning
 * it to the hoisted copy fails the build with MISSING_EXPORT. React and react-dom never
 * take that exception: a nested React is the second copy this plugin exists to stop.
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

            const nesting = isSingleton(source)
                ? []
                : packageDirsOf(importer).filter((dir) => existsSync(`${dir}/node_modules`));
            if (nesting.length > 0) {
                const own = await this.resolve(source, importer, { ...options, skipSelf: true });
                const id = own ? normalizePath(own.id) : "";
                if (own && nesting.some((dir) => id.startsWith(`${dir}${NODE_MODULES}`))) {
                    return own;
                }
            }

            return this.resolve(source, resolve(dashboardRoot, "_virtual.ts"), { ...options, skipSelf: true });
        },
    };
}
