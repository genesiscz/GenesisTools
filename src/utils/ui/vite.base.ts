import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
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
        async resolveId(source: string, importer: string | undefined, options: { skipSelf: boolean }) {
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
}: DashboardViteConfig): UserConfig {
    const { plugins: _ignored, resolve: _resolveIgnored, ...rest } = overrides;

    return defineConfig({
        root,
        plugins: [resolveSharedDeps(root), tailwindcss(), viteReact(), ...extraPlugins],
        server: {
            port,
            fs: {
                allow: [root, resolve(__dirname, "..")],
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
