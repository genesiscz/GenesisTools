import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type PluginOption, type UserConfig } from "vite";

export interface DashboardViteConfig {
    /** Root directory of the dashboard app */
    root: string;
    /** Dev server port */
    port: number;
    /** Additional Vite plugins to merge with defaults */
    plugins?: PluginOption[];
    /** Additional path aliases (merged with @ui default) */
    aliases?: Record<string, string>;
    /** Additional Vite config overrides (merged shallowly) */
    overrides?: Partial<UserConfig>;
    /** TanStack Start plugin options. Pass `false` to disable for non-Start apps. Default: enabled */
    tanstackStartOptions?: Parameters<typeof tanstackStart>[0] | false;
    /** Options passed to @vitejs/plugin-react (e.g., babel config) */
    reactOptions?: Parameters<typeof viteReact>[0];
    /** Extra sibling directories under @app to watch for SSR hot-reload (e.g. ["azure-devops"]).
     *  The tool's own directory and utils/ are watched automatically. */
    watchDirs?: string[];
}

/**
 * Path to the browser-safe polyfill for node:async_hooks.
 *
 * TanStack Start imports AsyncLocalStorage at module level in code paths that
 * run on both server and browser. In the browser Vite replaces node:async_hooks
 * with a stub that throws on use. This polyfill provides a no-op implementation
 * that satisfies the import without crashing. Used via resolve.alias below;
 * ssr.external ensures the real Node.js module is used during SSR.
 */
const BROWSER_ASYNC_HOOKS_POLYFILL = resolve(__dirname, "browser-async-hooks.ts");

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
 */
function pinNodeModules(dashboardRoot: string): Plugin {
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
                source.startsWith("@app")
            ) {
                return null;
            }

            const resolved = await this.resolve(source, resolve(dashboardRoot, "_virtual.ts"), {
                ...options,
                skipSelf: true,
            });

            return resolved;
        },
    };
}

/**
 * Vite plugin that watches directories outside root so SSR module cache
 * invalidates when files imported via path aliases (e.g. @app) change.
 */
function watchExternalDirs(dirs: string[]): Plugin {
    return {
        name: "watch-external-dirs",
        configureServer(server) {
            for (const dir of dirs) {
                server.watcher.add(dir);
            }
        },
    };
}

/**
 * Derive which directories outside `root` should be watched for SSR hot-reload.
 *
 * Auto-detects:
 * - The tool's own source directory (e.g. root=src/clarity/ui → watches src/clarity/)
 * - src/utils/ (shared utilities)
 *
 * Plus any explicit `extraDirs` (resolved relative to `appDir`).
 */
function deriveWatchDirs(root: string, appDir: string, extraDirs: string[]): string[] {
    const dirs: string[] = [];

    // If root is nested inside @app, find the tool directory
    // e.g. root=src/clarity/ui/, appDir=src/ → toolDir=src/clarity/
    const rootRelativeToApp = relative(appDir, root);

    if (
        rootRelativeToApp &&
        rootRelativeToApp !== "." &&
        !isAbsolute(rootRelativeToApp) &&
        rootRelativeToApp !== ".." &&
        !rootRelativeToApp.startsWith(`..${sep}`)
    ) {
        const toolName = rootRelativeToApp.split(/[\\/]/)[0];

        if (toolName) {
            const toolDir = resolve(appDir, toolName);

            if (toolDir !== root && existsSync(toolDir)) {
                dirs.push(toolDir);
            }
        }
    }

    // Always watch shared utils
    const utilsDir = resolve(appDir, "utils");

    if (utilsDir !== root && existsSync(utilsDir)) {
        dirs.push(utilsDir);
    }

    // Explicit extra directories (e.g. "azure-devops" → src/azure-devops/)
    for (const extra of extraDirs) {
        const dir = resolve(appDir, extra);
        const rel = relative(appDir, dir);

        if (
            rel &&
            rel !== "." &&
            !isAbsolute(rel) &&
            rel !== ".." &&
            !rel.startsWith(`..${sep}`) &&
            dir !== root &&
            existsSync(dir)
        ) {
            dirs.push(dir);
        }
    }

    return dirs;
}

export function createDashboardViteConfig({
    root,
    port,
    plugins: extraPlugins = [],
    aliases = {},
    overrides = {},
    tanstackStartOptions,
    reactOptions,
    watchDirs: extraWatchDirs = [],
}: DashboardViteConfig): UserConfig {
    const { plugins: _ignored, resolve: _resolveIgnored, optimizeDeps: overrideOptimizeDeps, ...rest } = overrides;
    const allAliases: Record<string, string> = { "@app": resolve(root, "src"), ...aliases };
    const appDir = allAliases["@app"];
    const externalWatchDirs = appDir ? deriveWatchDirs(root, appDir, extraWatchDirs) : [];

    const corePlugins: PluginOption[] = [pinNodeModules(root), tailwindcss()];

    if (externalWatchDirs.length > 0) {
        corePlugins.push(watchExternalDirs(externalWatchDirs));
    }

    if (tanstackStartOptions !== false) {
        corePlugins.push(tanstackStart(tanstackStartOptions ?? {}));
    }

    corePlugins.push(viteReact(reactOptions));

    return defineConfig({
        root,
        plugins: [...corePlugins, ...extraPlugins],
        server: {
            port,
            host: true,
            fs: {
                allow: [root, resolve(__dirname, "../../..")],
            },
            watch: {
                ignored: ["**/routeTree.gen.ts"],
            },
        },
        resolve: {
            alias: {
                "@ui": resolve(__dirname, "."),
                "node:async_hooks": BROWSER_ASYNC_HOOKS_POLYFILL,
                ...allAliases,
            },
        },
        optimizeDeps: {
            ...overrideOptimizeDeps,
            exclude: [
                "@tanstack/react-start-client",
                "@tanstack/start-client-core",
                ...(overrideOptimizeDeps?.exclude ?? []),
            ],
            include: [
                "@tanstack/history",
                "@tanstack/router-core",
                "@tanstack/router-core/isServer",
                "@tanstack/router-core/scroll-restoration-script",
                "@tanstack/router-core/ssr/client",
                "seroval",
                ...(overrideOptimizeDeps?.include ?? []),
            ],
        },
        ssr: {
            external: ["node:async_hooks", "bun"],
        },
        ...rest,
    }) as UserConfig;
}
