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
    // Per-environment dep optimizer fix for the dev-only duplicate-React bug.
    //
    // Under @tanstack/react-start, the `tanstackStart()` plugin only pre-bundles
    // React into the SSR environment when `optimizeDeps.noDiscovery === false`.
    // In non-standard SSR setups (our nested bun workspace included) that
    // condition isn't met, so the SSR environment *lazily discovers* React and
    // optimizes a SECOND copy — distinct from the client pre-bundle. The
    // browser then loads two `react*?v=<hash>` chunks; TanStack Query's
    // useSyncExternalStore observer subscribes on one React instance while the
    // tree renders on the other, so useQuery-driven routes hang on "Loading…"
    // forever (dev only — prod is a single Rollup graph).
    //
    // Fix (community-confirmed on TanStack/router#7119): explicitly declare
    // React in the SSR environment's optimizeDeps so it shares one pre-bundle
    // with the client. `react/compiler-runtime` is included because
    // babel-plugin-react-compiler injects it into every component — it's the
    // entry point the SSR optimizer was diverging on. `resolve.dedupe` alone
    // does NOT fix this (it only affects client-env resolution).
    // Refs: TanStack/router#7119, vitejs/vite#19323, vite-plugin-react#700.
    environments: {
        ssr: {
            optimizeDeps: {
                include: ["react", "react-dom", "react-dom/server", "react/jsx-runtime", "react/jsx-dev-runtime", "react/compiler-runtime"],
            },
        },
    },
    ssr: {
        // nitro virtual DB modules can't be bundled — keep them external.
        external: ["nitro/database", "#nitro-internal-virtual/database"],
        // Bundle Radix + TanStack through Vite (proper CJS→ESM interop); Radix
        // was crashing SSR with "Cannot read properties of null ('useMemo')".
        noExternal: [/^@radix-ui\//, /^@tanstack\//],
    },
    optimizeDeps: {
        // Client environment: pre-bundle every React entrypoint once so the
        // client optimizer produces a single shared React chunk.
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
