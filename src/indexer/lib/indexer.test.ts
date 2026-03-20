import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventName, IndexerEventMap } from "./events";
import { Indexer } from "./indexer";
import type { IndexConfig } from "./types";

let tempDir: string;
let indexName: string;
let counter = 0;

function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), "indexer-test-"));
}

function writeFixtureFile(dir: string, name: string, content: string): void {
    writeFileSync(join(dir, name), content);
}

function createConfig(overrides?: Partial<IndexConfig>): IndexConfig {
    counter++;
    indexName = `test_index_${Date.now()}_${counter}`;
    return {
        name: indexName,
        baseDir: tempDir,
        type: "code",
        respectGitIgnore: false,
        chunking: "auto",
        embedding: { enabled: false },
        watch: {
            strategy: "merkle",
        },
        ...overrides,
    };
}

beforeEach(() => {
    tempDir = createTempDir();
});

afterEach(() => {
    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch {
        // Cleanup best-effort
    }
});

describe("Indexer", () => {
    it(
        "sync() indexes new files and produces correct stats",
        async () => {
            writeFixtureFile(
                tempDir,
                "math.ts",
                `
export function add(a: number, b: number): number {
    return a + b;
}

export function multiply(a: number, b: number): number {
    return a * b;
}
`.trim()
            );

            writeFixtureFile(
                tempDir,
                "greet.ts",
                `
export function greet(name: string): string {
    return \`Hello, \${name}!\`;
}
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);

            try {
                const stats = await indexer.sync();

                expect(stats.filesScanned).toBe(2);
                expect(stats.chunksAdded + stats.chunksUpdated).toBeGreaterThan(0);
                expect(stats.durationMs).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "sync() skips unchanged files on second run",
        async () => {
            writeFixtureFile(
                tempDir,
                "stable.ts",
                `
export function stableFunc(): string {
    return "I never change";
}
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();
                const secondStats = await indexer.sync();

                expect(secondStats.filesScanned).toBe(1);
                expect(secondStats.chunksUnchanged).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "sync() detects modified files",
        async () => {
            const filePath = join(tempDir, "changing.ts");
            writeFileSync(
                filePath,
                `
export function version(): string {
    return "v1";
}
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();

                writeFileSync(
                    filePath,
                    `
export function version(): string {
    return "v2 - updated content";
}

export function newFunction(): number {
    return 42;
}
`.trim()
                );

                const secondStats = await indexer.sync();

                expect(secondStats.filesScanned).toBe(1);
                expect(secondStats.chunksAdded + secondStats.chunksUpdated).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "reindex() processes everything regardless",
        async () => {
            writeFixtureFile(
                tempDir,
                "always.ts",
                `
export function alwaysProcessed(): boolean {
    return true;
}
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();
                const reindexStats = await indexer.reindex();

                expect(reindexStats.filesScanned).toBe(1);
                expect(reindexStats.chunksAdded + reindexStats.chunksUpdated).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "search() returns results",
        async () => {
            writeFixtureFile(
                tempDir,
                "searchable.ts",
                `
export function calculateTotal(items: number[]): number {
    return items.reduce((sum, item) => sum + item, 0);
}

export function findMaximum(values: number[]): number {
    return Math.max(...values);
}
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();
                const results = await indexer.search("calculateTotal");

                expect(results.length).toBeGreaterThan(0);
                expect(results[0].score).toBeGreaterThan(0);
                expect(results[0].doc.content).toContain("calculateTotal");
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "events fire in correct order",
        async () => {
            writeFixtureFile(
                tempDir,
                "events.ts",
                `
export function eventTest(): void {
    console.log("testing events");
}
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);
            const eventOrder: string[] = [];

            indexer.on("*", (payload: { event: EventName } & IndexerEventMap[EventName]) => {
                eventOrder.push(payload.event);
            });

            try {
                await indexer.sync();

                expect(eventOrder[0]).toBe("sync:start");

                const scanStartIdx = eventOrder.indexOf("scan:start");
                const scanCompleteIdx = eventOrder.indexOf("scan:complete");
                const syncCompleteIdx = eventOrder.indexOf("sync:complete");

                expect(scanStartIdx).toBeGreaterThan(0);
                expect(scanCompleteIdx).toBeGreaterThan(scanStartIdx);
                expect(syncCompleteIdx).toBeGreaterThan(scanCompleteIdx);

                expect(eventOrder.includes("chunk:file") || eventOrder.includes("chunk:skip")).toBe(true);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "close() cleans up without errors",
        async () => {
            writeFixtureFile(
                tempDir,
                "cleanup.ts",
                `
export const x = 1;
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);

            await indexer.sync();
            await indexer.close();

            // No errors should have been thrown
            expect(true).toBe(true);
        },
        { timeout: 30_000 }
    );

    it(
        "name and stats getters work",
        async () => {
            writeFixtureFile(
                tempDir,
                "getters.ts",
                `
export function hello(): string {
    return "world";
}
`.trim()
            );

            const config = createConfig();
            const indexer = await Indexer.create(config);

            try {
                expect(indexer.name).toBe(config.name);

                await indexer.sync();

                const stats = indexer.stats;
                expect(stats.totalFiles).toBeGreaterThanOrEqual(0);
                expect(stats.totalChunks).toBeGreaterThanOrEqual(0);
                expect(stats.dbSizeBytes).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );
});
