import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
 * Two passes. The first is a direct value-import regex on each client tree.
 * The second walks the import graph out of the client tree, because a client
 * file may value-import a repo module that ITSELF pulls the logger: on
 * 2026-09-16 that chain (QaSessionActions.tsx → lib/qa-session-actions.ts →
 * lib/session-focus.ts → the logger) put @clack/prompts in the dev-dashboard
 * bundle, `globalThis.process.platform` threw at module evaluation, and the
 * whole dashboard rendered its boot splash forever. See
 * .claude/work/logger-client-vite-compat.md.
 */
const REPO = join(import.meta.dir, "..", "..", "..");

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
        // The DashboardApp harness entry beside the Vite app. It runs in Bun, not the browser.
        rel.endsWith("/ui/app.ts") ||
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
    /(?:import\s+(?!type\b)[^;]*?from\s+["']@(?:app|genesiscz)\/utils\/logger(?:\/out)?(?!\/client)["']|import\s+["']@(?:app|genesiscz)\/utils\/logger(?:\/out)?(?!\/client)["']|import\s*\(\s*["']@(?:app|genesiscz)\/utils\/logger(?:\/out)?(?!\/client)["']\s*\))/g;

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
            'import { logger } from "@genesiscz/utils/logger/client"',
            'import { out } from "@genesiscz/utils/logger/client"',
            'import { logger, out } from "@genesiscz/utils/logger/client"',
        ];
        for (const line of allowedImports) {
            const matches = [...line.matchAll(VALUE_LOGGER_IMPORT)];
            expect(matches).toHaveLength(0);
        }
    });

    it("still blocks @app/logger and @app/logger/out imports", () => {
        const blockedImports = [
            'import { logger } from "@genesiscz/utils/logger"',
            'import { out } from "@genesiscz/utils/logger/out"',
            'import "@genesiscz/utils/logger"',
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

// ── Transitive pass ───────────────────────────────────────────────────────────
// The regex above only sees the client file itself. Everything below follows the
// value-import edges out of the client tree so a two-hop chain cannot hide.

const LOGGER_SPEC = /^@(?:app|genesiscz)\/utils\/logger(?:\/out)?$/;

interface ModuleImport {
    spec: string;
    typeOnly: boolean;
}

/** Every `from "…"` and bare `import "…"`, with the `import type …` form marked. */
function moduleImports(src: string): ModuleImport[] {
    const found: ModuleImport[] = [];
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)([\s\S]*?)from\s*["']([^"']+)["']/g)) {
        found.push({ spec: m[2], typeOnly: /^\s*type\s/.test(m[1]) });
    }

    for (const m of src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
        found.push({ spec: m[1], typeOnly: false });
    }

    return found;
}

/**
 * Resolve the alias forms every dashboard shares. A spec this cannot resolve is simply
 * not followed, so the guard can under-report but never invent an offender.
 */
function resolveSpec(spec: string, fromFile: string, clientRootAbs: string): string | null {
    let base: string;

    if (spec.startsWith("@app/")) {
        base = join(REPO, "src", spec.slice("@app/".length));
    } else if (spec.startsWith("@genesiscz/utils/")) {
        base = join(REPO, "src/utils", spec.slice("@genesiscz/utils/".length));
    } else if (spec.startsWith("@ui/")) {
        base = join(REPO, "src/utils/ui", spec.slice("@ui/".length));
    } else if (spec.startsWith("@/")) {
        base = join(clientRootAbs, "src", spec.slice(2));
    } else if (spec.startsWith(".")) {
        base = resolve(dirname(fromFile), spec);
    } else {
        return null;
    }

    const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];

    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/**
 * Where the walk stops. A TanStack Start route that declares `createServerFn` keeps its
 * handler — and that handler's imports — out of the client bundle, so following those edges
 * would report chains the bundler already cut. Such a file is still covered by the direct
 * regex pass above, which reads the file itself rather than what it imports.
 */
function isBundlerBoundary(src: string): boolean {
    return src.includes("createServerFn");
}

/** The chain from a client file to the logger, or null when that tree stays clean. */
function chainToLogger(entry: string, clientRootAbs: string, sourceOf: Map<string, string>): string[] | null {
    const seen = new Set([entry]);
    const queue: string[][] = [[entry]];

    while (queue.length > 0) {
        const path = queue.shift() as string[];
        const file = path[path.length - 1];
        let src = sourceOf.get(file);

        if (src === undefined) {
            src = readFileSync(file, "utf8");
            sourceOf.set(file, src);
        }

        if (isBundlerBoundary(src)) {
            continue;
        }

        for (const imported of moduleImports(src)) {
            if (imported.typeOnly) {
                continue;
            }

            if (LOGGER_SPEC.test(imported.spec)) {
                return [...path, imported.spec];
            }

            const next = resolveSpec(imported.spec, file, clientRootAbs);

            if (!next || seen.has(next) || isServerOrTooling(next.slice(REPO.length + 1))) {
                continue;
            }

            seen.add(next);
            queue.push([...path, next]);
        }
    }

    return null;
}

describe("browser-client trees never reach @app/logger through another module", () => {
    it("no client source pulls the Node logger transitively", () => {
        const offenders: string[] = [];
        const sourceOf = new Map<string, string>();

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

                const chain = chainToLogger(file, abs, sourceOf);

                if (chain) {
                    offenders.push(chain.map((step) => step.replace(`${REPO}/`, "")).join(" -> "));
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});
