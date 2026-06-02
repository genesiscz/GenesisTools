import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards what makes the contract React-Native-bundle-safe: it may carry TYPES from
// anywhere (type-only re-exports erase), but must never pull RUNTIME code from the
// server's lib/*, nor any node:/bun: module, into the data/client modules.

const FILES = [
    "dto.ts",
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
});
