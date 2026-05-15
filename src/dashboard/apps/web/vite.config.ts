import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import type { NitroConfig } from "nitro/types";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const nitroConfig: NitroConfig = {
    experimental: {
        database: true,
        websocket: true, // Enable WebSocket support for live sync
    },
    database: {
        default: {
            connector: "sqlite",
            options: { name: "dashboard" },
        },
    },
    // Scan server/routes directory for API and WebSocket handlers
    scanDirs: ["./server"],
};

const dashboardDependency = (specifier: string) => new URL(`./node_modules/${specifier}`, import.meta.url).pathname;

const config = defineConfig({
    server: {
        hmr: {
            overlay: false,
        },
    },
    plugins: [
        devtools(),
        nitro(nitroConfig),
        // this is the plugin that enables path aliases
        viteTsConfigPaths({
            projects: ["./tsconfig.json"],
        }),
        tailwindcss(),
        tanstackStart(),
        viteReact({
            babel: {
                plugins: ["babel-plugin-react-compiler"],
            },
        }),
    ],
    resolve: {
        alias: [
            { find: "@ui", replacement: new URL("../../../utils/ui", import.meta.url).pathname },
            {
                find: "@dashboard/shared",
                replacement: new URL("../../packages/shared/src/index.ts", import.meta.url).pathname,
            },
            { find: "@dashboard/ui", replacement: new URL("../../packages/ui/src/index.ts", import.meta.url).pathname },
            { find: "@radix-ui/react-avatar", replacement: dashboardDependency("@radix-ui/react-avatar") },
            { find: "@radix-ui/react-dialog", replacement: dashboardDependency("@radix-ui/react-dialog") },
            {
                find: "@radix-ui/react-dropdown-menu",
                replacement: dashboardDependency("@radix-ui/react-dropdown-menu"),
            },
            { find: "@radix-ui/react-separator", replacement: dashboardDependency("@radix-ui/react-separator") },
            { find: "@radix-ui/react-slot", replacement: dashboardDependency("@radix-ui/react-slot") },
            { find: "@radix-ui/react-tooltip", replacement: dashboardDependency("@radix-ui/react-tooltip") },
        ],
    },
    // SSR config - mark browser-only packages and nitro internals as external
    ssr: {
        external: ["nitro/database", "#nitro-internal-virtual/database", "@powersync/web", "@journeyapps/wa-sqlite"],
        noExternal: [
            "@radix-ui/react-avatar",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-separator",
            "@radix-ui/react-slot",
            "@radix-ui/react-tooltip",
        ],
    },
    // PowerSync web workers require 'es' format for code-splitting builds
    worker: {
        format: "es",
    },
    // PowerSync worker/WASM configuration
    // Exclude packages with workers/WASM from optimization
    optimizeDeps: {
        exclude: ["@journeyapps/wa-sqlite", "@powersync/web", "nitro", "nitro/database"],
        include: ["@powersync/web > js-logger"],
    },
});

export default config;
