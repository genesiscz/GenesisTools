import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "./indexer";
import { IndexerManager } from "./manager";
import type { IndexConfig } from "./types";

let tempDir: string;
let counter = 0;

function uniqueIndexName(): string {
    counter++;
    return `e2e_test_${Date.now()}_${counter}`;
}

function makeConfig(overrides?: Partial<IndexConfig>): IndexConfig {
    return {
        name: uniqueIndexName(),
        baseDir: tempDir,
        type: "code",
        respectGitIgnore: false,
        chunking: "auto",
        embedding: { enabled: false },
        watch: { strategy: "merkle" },
        ...overrides,
    };
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "indexer-e2e-"));
});

afterEach(() => {
    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch {
        // best-effort
    }
});

afterAll(async () => {
    const manager = await IndexerManager.load();
    const names = manager.getIndexNames().filter((n) => n.startsWith("e2e_test_"));

    for (const name of names) {
        try {
            await manager.removeIndex(name);
        } catch {
            // best-effort
        }
    }

    await manager.close();
});

describe("E2E: index -> search -> verify", () => {
    it(
        "indexes multiple TS files and returns ranked search results",
        async () => {
            writeFileSync(
                join(tempDir, "auth.ts"),
                `
export function authenticateUser(username: string, password: string): boolean {
    // Verify credentials against the database
    return username === "admin" && password === "secret";
}

export function hashPassword(raw: string): string {
    return raw.split("").reverse().join("");
}
`.trim()
            );

            writeFileSync(
                join(tempDir, "math.ts"),
                `
export function fibonacci(n: number): number {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

export function factorial(n: number): number {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}
`.trim()
            );

            writeFileSync(
                join(tempDir, "http.ts"),
                `
export async function fetchJSON(url: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    return response.json();
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                const stats = await indexer.sync();

                // All 3 files should be indexed
                expect(stats.filesScanned).toBe(3);
                expect(stats.chunksAdded).toBeGreaterThan(0);

                // Search for authentication — should find auth.ts
                const authResults = await indexer.search("authenticateUser password");
                expect(authResults.length).toBeGreaterThan(0);
                expect(authResults[0].doc.content).toContain("authenticateUser");
                expect(authResults[0].doc.filePath).toContain("auth.ts");

                // Search for fibonacci — should find math.ts
                const mathResults = await indexer.search("fibonacci factorial");
                expect(mathResults.length).toBeGreaterThan(0);
                expect(mathResults[0].doc.content).toContain("fibonacci");
                expect(mathResults[0].doc.filePath).toContain("math.ts");

                // Search for HTTP fetch — should find http.ts
                const httpResults = await indexer.search("fetchJSON");
                expect(httpResults.length).toBeGreaterThan(0);
                expect(httpResults[0].doc.content).toContain("fetchJSON");
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "delete + re-sync removes stale chunks and adds new ones",
        async () => {
            writeFileSync(join(tempDir, "original.ts"), 'export const greeting = "hello";');

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();

                // Verify original is searchable
                const before = await indexer.search("greeting");
                expect(before.length).toBeGreaterThan(0);

                // Delete original, add replacement
                unlinkSync(join(tempDir, "original.ts"));
                writeFileSync(join(tempDir, "replacement.ts"), 'export const farewell = "goodbye";');

                const stats = await indexer.sync();
                expect(stats.chunksRemoved).toBeGreaterThan(0);
                expect(stats.chunksAdded).toBeGreaterThan(0);

                // Original should no longer appear
                const afterOriginal = await indexer.search("greeting hello");
                const hasOriginal = afterOriginal.some((r) => r.doc.filePath.includes("original.ts"));
                expect(hasOriginal).toBe(false);

                // Replacement should be searchable
                const afterReplacement = await indexer.search("farewell goodbye");
                expect(afterReplacement.length).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );
});
