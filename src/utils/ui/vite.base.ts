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
}

/**
 * Vite plugin that ensures bare module imports from shared UI files
 * resolve against the dashboard's node_modules, not the file's location.
 */
export function resolveSharedDeps(appRoot: string): Plugin {
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

export function createDashboardViteConfig({
    root,
    port,
    plugins: extraPlugins = [],
    aliases = {},
    overrides = {},
    tanstackStartOptions,
    reactOptions,
}: DashboardViteConfig): UserConfig {
    const { plugins: _ignored, resolve: _resolveIgnored, ...rest } = overrides;

    const corePlugins: PluginOption[] = [resolveSharedDeps(root), tailwindcss()];

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
                "@app": resolve(root, "src"),
                ...aliases,
            },
        },
        ...rest,
    }) as UserConfig;
}
