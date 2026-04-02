import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
 * Vite plugin that ensures bare module imports from shared UI files
 * resolve against the dashboard's node_modules, not the file's location.
 */
function resolveSharedDeps(appRoot: string): Plugin {
    const uiDir = resolve(__dirname, ".");

    return {
        name: "resolve-shared-ui-deps",
        enforce: "pre",
        async resolveId(
            source: string,
            importer: string | undefined,
            options: { isEntry: boolean; [key: string]: unknown }
        ) {
            if (!importer || !importer.startsWith(uiDir)) {
                return null;
            }

            if (source.startsWith(".") || source.startsWith("/") || source.startsWith("@ui")) {
                return null;
            }

            const resolved = await this.resolve(source, resolve(appRoot, "src", "_virtual.ts"), {
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
    const normalRoot = root.endsWith("/") ? root : `${root}/`;
    const normalApp = appDir.endsWith("/") ? appDir : `${appDir}/`;
    const dirs: string[] = [];

    // If root is nested inside @app, find the tool directory
    // e.g. root=src/clarity/ui/, appDir=src/ → toolDir=src/clarity/
    if (normalRoot.startsWith(normalApp)) {
        const relative = normalRoot.slice(normalApp.length); // "clarity/ui/"
        const toolName = relative.split("/")[0];

        if (toolName) {
            const toolDir = resolve(appDir, toolName);

            if (toolDir !== root) {
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

        if (dir !== root && existsSync(dir)) {
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
    const { plugins: _ignored, resolve: _resolveIgnored, ...rest } = overrides;
    const allAliases: Record<string, string> = { "@app": resolve(root, "src"), ...aliases };
    const appDir = allAliases["@app"];
    const externalWatchDirs = appDir ? deriveWatchDirs(root, appDir, extraWatchDirs) : [];

    const corePlugins: PluginOption[] = [resolveSharedDeps(root), tailwindcss()];

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
                ...allAliases,
            },
        },
        ...rest,
    }) as UserConfig;
}
