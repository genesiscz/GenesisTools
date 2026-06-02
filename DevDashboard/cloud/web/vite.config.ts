import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import type { NitroConfig } from "nitro/types";
import { nitro } from "nitro/vite";
import { defineConfig, type UserConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import type { InlineConfig as VitestInlineConfig } from "vitest/node";

// Vite's UserConfig doesn't declare `test`; vitest reads it at runtime from the merged config.
// We extend the type here rather than importing defineConfig from "vitest/config" — that pulls
// vitest's bundled copy of Vite's plugin types, which mismatches vite@8's rolldown PluginContextMeta
// and breaks `tsc`. This keeps both the vite plugin types AND the vitest `test` field strongly typed.
type ConfigWithTest = UserConfig & { test: VitestInlineConfig };

const nitroConfig: NitroConfig = {
    experimental: {
        websocket: false,
    },
    logLevel: process.env.NODE_ENV === "production" ? 3 : 0,
};

const bindHost = process.env.DD_CLOUD_BIND_HOST;

const config: ConfigWithTest = {
    server: {
        ...(bindHost ? { host: bindHost } : {}),
        hmr: {
            overlay: false,
        },
    },
    plugins: [
        nitro(nitroConfig),
        viteTsConfigPaths({
            projects: ["./tsconfig.json"],
        }),
        tailwindcss(),
        tanstackStart(),
        viteReact(),
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
    },
    // Per-environment dep-optimizer fix for the dev-only duplicate-React bug under
    // @tanstack/react-start + a nested bun workspace (TanStack/router#7119). The SSR
    // environment lazily discovers React and optimizes a SECOND copy distinct from the
    // client pre-bundle; useSyncExternalStore then subscribes to one React instance while
    // the tree renders on the other and useQuery-driven routes hang on "Loading…" in dev.
    // Declaring React in the SSR optimizeDeps shares one pre-bundle with the client.
    environments: {
        ssr: {
            optimizeDeps: {
                include: [
                    "react",
                    "react-dom",
                    "react-dom/server",
                    "react/jsx-runtime",
                    "react/jsx-dev-runtime",
                ],
            },
        },
    },
    ssr: {
        external: ["nitro/database", "#nitro-internal-virtual/database", "better-sqlite3"],
    },
    optimizeDeps: {
        include: [
            "react",
            "react-dom",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "react-dom/client",
            "@tanstack/react-query",
            "@tanstack/query-core",
        ],
        exclude: ["nitro", "nitro/database", "better-sqlite3"],
    },
    test: {
        // Node environment so better-sqlite3 (native) loads. Only our own src tests run here;
        // the framework-agnostic shared/ layer runs under `bun test` (no native deps).
        environment: "node",
        include: ["src/**/*.test.ts"],
        server: {
            deps: {
                // better-sqlite3 is native — never let vitest try to transform/inline it.
                external: ["better-sqlite3"],
            },
        },
    },
};

export default defineConfig(config);
