import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards what makes the contract React-Native-bundle-safe: it may carry TYPES from
// anywhere (type-only re-exports erase), but must never pull RUNTIME code from the
// server's lib/*, nor any node:/bun: module, into the data/client modules.

const FILES = [
    "dto.ts",
    "ai-accounts.ts",
    "endpoints.ts",
    "client.ts",
    "index.ts",
    "auth-header.ts",
    "pairing.ts",
    "e2e-envelope.ts",
    "e2e-request.ts",
    "box-types.ts",
];

describe("contract purity", () => {
    it("never VALUE-imports from @app/dev-dashboard/lib in any contract file", () => {
        const offenders = FILES.filter((file) => {
            const src = readFileSync(join(import.meta.dir, file), "utf8");

            return /^import\s+(?!type\b)[^;]*from\s+["']@app\/dev-dashboard\/lib/m.test(src);
        });

        expect(offenders).toEqual([]);
    });

    it("never imports a node:/bun: runtime module in dto.ts or client.ts", () => {
        const offenders = ["dto.ts", "client.ts"].filter((file) => {
            const src = readFileSync(join(import.meta.dir, file), "utf8");

            return /from\s+["'](?:node:|bun:)/.test(src);
        });

        expect(offenders).toEqual([]);
    });

    // Every `@genesiscz/utils/*` the contract VALUE-imports must have an RN shim in the mobile app's
    // Metro alias table. Without one Metro resolves the repo's server-side module and pulls its
    // `node:` dependencies into Hermes — which is how the pino logger reached the bundle through a
    // single `logger.warn` in auth-header.ts.
    it("every @genesiscz/utils value-import the contract makes is aliased for the mobile bundle", () => {
        const metroConfig = readFileSync(
            join(import.meta.dir, "../../../DevDashboard/mobile/metro.config.js"),
            "utf8",
        );
        const unaliased: string[] = [];

        for (const file of FILES) {
            const src = readFileSync(join(import.meta.dir, file), "utf8");

            for (const match of src.matchAll(/^import\s+(?!type\b)[^;]*from\s+["'](@genesiscz\/utils[^"']*)["']/gm)) {
                const specifier = match[1];

                if (!metroConfig.includes(`match: "${specifier}"`)) {
                    unaliased.push(`${file} → ${specifier}`);
                }
            }
        }

        expect(unaliased).toEqual([]);
    });
});
