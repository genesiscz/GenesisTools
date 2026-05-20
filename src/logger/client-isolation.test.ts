import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `@app/logger` statically pulls pino + pino-pretty + node:stream + (post
 * Task 9) @clack/prompts. None of that is browser-safe. Today NO browser
 * client bundle imports it — but that safety is *incidental* (convention,
 * unenforced). This guard converts "incidentally safe" → "enforced safe":
 * no browser-client source in any Vite app may value-import `@app/logger`
 * (or `@app/logger/out`). Server-side TanStack Start handlers
 * (`routes/api/**`, `server/**`), the Node dev-server middleware, and
 * vite/test config legitimately use the Node logger and are excluded.
 *
 * Coarse-by-design: a direct value-import regex on each client tree. It does
 * not chase transitive chains (current client reach is zero, and the one
 * fragile edge — RegularsPanel.tsx → `import type` of a logger-importing
 * module — is type-only and erased). See
 * .claude/work/logger-client-vite-compat.md.
 */
const REPO = join(import.meta.dir, "..", "..");

// Browser-client Vite app roots (the SSR/Nitro halves are excluded per-file).
const CLIENT_ROOTS = [
    "src/clarity/ui",
    "src/claude-history-dashboard",
    "src/dashboard/apps/web",
    "src/debugging-master/dashboard",
    "src/dev-dashboard/ui",
    "src/shops/ui",
    "src/youtube/extension",
    "src/youtube/ui",
    "src/Internal/commands/reas/ui",
];

// Server-side / tooling files inside a client tree that MAY import the Node
// logger (they never reach the browser bundle).
function isServerOrTooling(rel: string): boolean {
    return (
        rel.includes("/routes/api/") ||
        rel.includes("/server/") ||
        rel.endsWith(".test.ts") ||
        rel.endsWith(".test.tsx") ||
        rel.includes("vite-middleware") ||
        rel.includes("vite.plugins/") ||
        /vite\.config\.[cm]?[jt]s$/.test(rel) ||
        rel.includes("/node_modules/") ||
        rel.includes("/dist/")
    );
}

// Any non-type value import of @app/logger or @app/logger/out — covers the
// `import … from "…"` form (excluding `import type`), the side-effect form
// `import "…"`, and the dynamic `import("…")` form (PR #176 review t12).
// Carve-out: @app/logger/client is the browser-safe facade and IS allowed
// in client trees (negative lookahead (?!\/client) excludes it).
const VALUE_LOGGER_IMPORT =
    /(?:import\s+(?!type\b)[^;]*?from\s+["']@app\/logger(?:\/out)?(?!\/client)["']|import\s+["']@app\/logger(?:\/out)?(?!\/client)["']|import\s*\(\s*["']@app\/logger(?:\/out)?(?!\/client)["']\s*\))/g;

function walk(dir: string, acc: string[]): void {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules" || name === "dist" || name === ".vite") {
            continue;
        }

        const st = statSync(full);
        if (st.isDirectory()) {
            walk(full, acc);
            continue;
        }

        if (/\.(ts|tsx|mts|cts)$/.test(name)) {
            acc.push(full);
        }
    }
}

describe("VALUE_LOGGER_IMPORT regex carve-outs", () => {
    it("allows @app/logger/client imports (browser-safe facade)", () => {
        const allowedImports = [
            'import { logger } from "@app/logger/client"',
            'import { out } from "@app/logger/client"',
            'import { logger, out } from "@app/logger/client"',
        ];
        for (const line of allowedImports) {
            const matches = [...line.matchAll(VALUE_LOGGER_IMPORT)];
            expect(matches).toHaveLength(0);
        }
    });

    it("still blocks @app/logger and @app/logger/out imports", () => {
        const blockedImports = [
            'import { logger } from "@app/logger"',
            'import { out } from "@app/logger/out"',
            'import "@app/logger"',
        ];
        for (const line of blockedImports) {
            const matches = [...line.matchAll(VALUE_LOGGER_IMPORT)];
            expect(matches.length).toBeGreaterThan(0);
        }
    });
});

describe("browser-client trees never value-import @app/logger", () => {
    it("no client source pulls the Node logger (server handlers excluded)", () => {
        const offenders: string[] = [];
        for (const root of CLIENT_ROOTS) {
            const abs = join(REPO, root);
            if (!existsSync(abs)) {
                continue;
            }

            const files: string[] = [];
            walk(abs, files);
            for (const file of files) {
                const rel = file.slice(REPO.length + 1);
                if (isServerOrTooling(rel)) {
                    continue;
                }

                const src = readFileSync(file, "utf8");
                for (const m of src.matchAll(VALUE_LOGGER_IMPORT)) {
                    offenders.push(`${rel}: ${m[0].replace(/\s+/g, " ").trim()}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});
