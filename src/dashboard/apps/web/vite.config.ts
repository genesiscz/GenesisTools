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
        websocket: false,
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
        dedupe: [
            "react",
            "react-dom",
            "@tanstack/react-query",
            "@tanstack/query-core",
            "@tanstack/react-router",
            "@tanstack/react-start",
            "@tanstack/router-core",
        ],
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
    // SSR config - mark nitro internals as external
    ssr: {
        external: ["nitro/database", "#nitro-internal-virtual/database"],
        noExternal: [/^@radix-ui\//, /^@tanstack\//],
    },
    optimizeDeps: {
        include: [
            "react",
            "react-dom",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "react/compiler-runtime",
            "react-dom/client",
            "@tanstack/react-query",
            "@tanstack/query-core",
        ],
        exclude: ["nitro", "nitro/database"],
    },
});

export default config;
