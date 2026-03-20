import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventName, IndexerCallbacks, IndexerEventMap } from "./events";
import { Indexer } from "./indexer";
import { IndexerManager } from "./manager";
import type { IndexConfig } from "./types";

let tempDir: string;
let counter = 0;

function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), "indexer-integration-"));
}

function writeFixture(dir: string, name: string, content: string): void {
    writeFileSync(join(dir, name), content);
}

function uniqueIndexName(): string {
    counter++;
    return `integration_test_${Date.now()}_${counter}`;
}

function makeConfig(overrides?: Partial<IndexConfig>): IndexConfig {
    return {
        name: uniqueIndexName(),
        baseDir: tempDir,
        type: "code",
        respectGitIgnore: false,
        chunking: "auto",
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

describe("IndexerManager lifecycle", () => {
    it(
        "addIndex -> listIndexes -> getIndex + search -> removeIndex",
        async () => {
            writeFixture(
                tempDir,
                "calculator.ts",
                `
export function add(a: number, b: number): number {
    return a + b;
}

export function subtract(a: number, b: number): number {
    return a - b;
}

export function multiply(a: number, b: number): number {
    return a * b;
}
`.trim()
            );

            writeFixture(
                tempDir,
                "formatter.ts",
                `
export function formatCurrency(amount: number): string {
    return \`$\${amount.toFixed(2)}\`;
}

export function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}
`.trim()
            );

            const config = makeConfig();
            const manager = await IndexerManager.load();

            try {
                // Add index (this also runs initial sync)
                const indexer = await manager.addIndex(config);
                expect(indexer.name).toBe(config.name);

                // Verify it appears in the list
                const indexes = manager.listIndexes();
                const found = indexes.find((m) => m.name === config.name);
                expect(found).toBeDefined();

                if (found) {
                    expect(found.stats.totalFiles).toBeGreaterThan(0);
                    expect(found.lastSyncAt).not.toBeNull();
                }

                // Get the index and search
                const retrieved = await manager.getIndex(config.name);
                const results = await retrieved.search("add");

                expect(results.length).toBeGreaterThan(0);
                expect(results[0].score).toBeGreaterThan(0);
                expect(results[0].doc.content).toBeDefined();

                // Remove the index
                await manager.removeIndex(config.name);

                // Verify it's gone
                const afterRemove = manager.listIndexes();
                const stillThere = afterRemove.find((m) => m.name === config.name);
                expect(stillThere).toBeUndefined();
            } finally {
                await manager.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "addIndex throws for duplicate name",
        async () => {
            writeFixture(tempDir, "dummy.ts", "export const x = 1;");

            const config = makeConfig();
            const manager = await IndexerManager.load();

            try {
                await manager.addIndex(config);

                await expect(manager.addIndex(config)).rejects.toThrow("already exists");
            } finally {
                await manager.removeIndex(config.name);
                await manager.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "removeIndex throws for nonexistent name",
        async () => {
            const manager = await IndexerManager.load();

            try {
                await expect(manager.removeIndex("nonexistent_xyz_999")).rejects.toThrow("not found");
            } finally {
                await manager.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "getIndex throws for nonexistent name",
        async () => {
            const manager = await IndexerManager.load();

            try {
                await expect(manager.getIndex("nonexistent_xyz_999")).rejects.toThrow("not found");
            } finally {
                await manager.close();
            }
        },
        { timeout: 30_000 }
    );
});

describe("Indexer with callbacks", () => {
    it(
        "inline callbacks fire during sync",
        async () => {
            writeFixture(
                tempDir,
                "callback-test.ts",
                `
export function callbackTestFunction(): void {
    console.log("testing callbacks");
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            const receivedEvents: string[] = [];

            const callbacks: IndexerCallbacks = {
                onSyncStart: (payload) => {
                    receivedEvents.push("sync:start");
                    expect(payload.indexName).toBe(config.name);
                    expect(payload.mode).toBe("incremental");
                },
                onScanStart: (payload) => {
                    receivedEvents.push("scan:start");
                    expect(payload.indexName).toBe(config.name);
                },
                onScanComplete: (payload) => {
                    receivedEvents.push("scan:complete");
                    expect(payload.indexName).toBe(config.name);
                    expect(typeof payload.added).toBe("number");
                    expect(typeof payload.deleted).toBe("number");
                },
                onChunkFile: (payload) => {
                    receivedEvents.push("chunk:file");
                    expect(payload.indexName).toBe(config.name);
                    expect(payload.chunks).toBeGreaterThan(0);
                    expect(payload.filePath).toBeDefined();
                },
                onSyncComplete: (payload) => {
                    receivedEvents.push("sync:complete");
                    expect(payload.indexName).toBe(config.name);
                    expect(payload.durationMs).toBeGreaterThan(0);
                    expect(payload.stats.filesScanned).toBeGreaterThan(0);
                },
            };

            try {
                await indexer.sync(callbacks);

                expect(receivedEvents).toContain("sync:start");
                expect(receivedEvents).toContain("scan:start");
                expect(receivedEvents).toContain("scan:complete");
                expect(receivedEvents).toContain("chunk:file");
                expect(receivedEvents).toContain("sync:complete");
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );
});

describe("Incremental sync", () => {
    it(
        "second sync only processes new files",
        async () => {
            writeFixture(
                tempDir,
                "initial-a.ts",
                `
export function initialA(): string {
    return "file A";
}
`.trim()
            );

            writeFixture(
                tempDir,
                "initial-b.ts",
                `
export function initialB(): string {
    return "file B";
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                // First sync indexes both files
                const firstStats = await indexer.sync();
                expect(firstStats.filesScanned).toBe(2);
                expect(firstStats.chunksAdded + firstStats.chunksUpdated).toBeGreaterThan(0);

                // Add a third file
                writeFixture(
                    tempDir,
                    "added-c.ts",
                    `
export function addedC(): number {
    return 42;
}
`.trim()
                );

                // Second sync should detect the new file
                const secondStats = await indexer.sync();
                expect(secondStats.filesScanned).toBe(3);

                // The unchanged files should be detected as unchanged
                expect(secondStats.chunksUnchanged).toBeGreaterThan(0);

                // The new file should be processed
                expect(secondStats.chunksAdded + secondStats.chunksUpdated).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "modified file is re-chunked on second sync",
        async () => {
            const filePath = join(tempDir, "mutable.ts");
            writeFileSync(
                filePath,
                `
export function version(): string {
    return "v1";
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();

                // Modify the file
                writeFileSync(
                    filePath,
                    `
export function version(): string {
    return "v2 - modified content with extra text";
}

export function brandNewFunction(): boolean {
    return true;
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
});

describe("Search consistency", () => {
    it(
        "fulltext search returns consistent results across calls",
        async () => {
            writeFixture(
                tempDir,
                "searchable.ts",
                `
export function calculateTotal(items: number[]): number {
    return items.reduce((sum, item) => sum + item, 0);
}

export function findMaximum(values: number[]): number {
    return Math.max(...values);
}

export function computeAverage(data: number[]): number {
    if (data.length === 0) {
        return 0;
    }
    return calculateTotal(data) / data.length;
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();

                const results1 = await indexer.search("calculateTotal", { mode: "fulltext" });
                const results2 = await indexer.search("calculateTotal", { mode: "fulltext" });

                expect(results1.length).toBeGreaterThan(0);
                expect(results2.length).toBeGreaterThan(0);
                expect(results1.length).toBe(results2.length);

                // Scores should be identical for the same query
                for (let i = 0; i < results1.length; i++) {
                    expect(results1[i].score).toBe(results2[i].score);
                    expect(results1[i].doc.id).toBe(results2[i].doc.id);
                }
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "search returns relevant results",
        async () => {
            writeFixture(
                tempDir,
                "animals.ts",
                `
export function feedDog(food: string): void {
    console.log(\`Feeding dog: \${food}\`);
}
`.trim()
            );

            writeFixture(
                tempDir,
                "vehicles.ts",
                `
export function startEngine(vehicleId: string): void {
    console.log(\`Starting engine: \${vehicleId}\`);
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();

                const dogResults = await indexer.search("feedDog");
                expect(dogResults.length).toBeGreaterThan(0);

                // The top result should contain the dog-related content
                const topDoc = dogResults[0].doc;
                expect(topDoc.content).toContain("feedDog");

                const engineResults = await indexer.search("startEngine");
                expect(engineResults.length).toBeGreaterThan(0);
                expect(engineResults[0].doc.content).toContain("startEngine");
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );
});

describe("Event ordering", () => {
    it(
        "wildcard listener receives events in correct order",
        async () => {
            writeFixture(
                tempDir,
                "event-order.ts",
                `
export function orderedFunction(): string {
    return "testing event ordering";
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);
            const eventLog: Array<{ event: string; ts: number }> = [];

            indexer.on("*", (payload: { event: EventName } & IndexerEventMap[EventName]) => {
                eventLog.push({ event: payload.event, ts: payload.ts });
            });

            try {
                await indexer.sync();

                // Extract event names in order
                const eventNames = eventLog.map((e) => e.event);

                // sync:start must be first
                expect(eventNames[0]).toBe("sync:start");

                // scan:start must come before scan:complete
                const scanStartIdx = eventNames.indexOf("scan:start");
                const scanCompleteIdx = eventNames.indexOf("scan:complete");
                expect(scanStartIdx).toBeGreaterThan(-1);
                expect(scanCompleteIdx).toBeGreaterThan(scanStartIdx);

                // chunk:file or chunk:skip must appear between scan events and sync:complete
                const hasChunkEvent = eventNames.some((e) => e === "chunk:file" || e === "chunk:skip");
                expect(hasChunkEvent).toBe(true);

                // sync:complete must be last
                const syncCompleteIdx = eventNames.indexOf("sync:complete");
                expect(syncCompleteIdx).toBe(eventNames.length - 1);

                // Timestamps should be monotonically non-decreasing
                for (let i = 1; i < eventLog.length; i++) {
                    expect(eventLog[i].ts).toBeGreaterThanOrEqual(eventLog[i - 1].ts);
                }
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "namespace wildcard captures all events in namespace",
        async () => {
            writeFixture(
                tempDir,
                "ns-wildcard.ts",
                `
export function nsTest(): void {
    console.log("namespace test");
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);
            const syncEvents: string[] = [];
            const scanEvents: string[] = [];

            indexer.on("sync:*", (payload) => {
                syncEvents.push(payload.event);
            });

            indexer.on("scan:*", (payload) => {
                scanEvents.push(payload.event);
            });

            try {
                await indexer.sync();

                expect(syncEvents).toContain("sync:start");
                expect(syncEvents).toContain("sync:complete");

                expect(scanEvents).toContain("scan:start");
                expect(scanEvents).toContain("scan:complete");
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );
});

describe("Manager rebuildIndex", () => {
    it(
        "rebuilds an index through the manager",
        async () => {
            writeFixture(
                tempDir,
                "rebuild-target.ts",
                `
export function rebuildMe(): string {
    return "should be rebuilt";
}
`.trim()
            );

            const config = makeConfig();
            const manager = await IndexerManager.load();

            try {
                await manager.addIndex(config);

                const stats = await manager.rebuildIndex(config.name);
                expect(stats.filesScanned).toBeGreaterThan(0);
                expect(stats.chunksAdded + stats.chunksUpdated).toBeGreaterThan(0);
                expect(stats.durationMs).toBeGreaterThan(0);
            } finally {
                await manager.removeIndex(config.name);
                await manager.close();
            }
        },
        { timeout: 30_000 }
    );
});

describe("Manager syncAll", () => {
    it(
        "syncs all indexes at once",
        async () => {
            const dir1 = createTempDir();
            const dir2 = createTempDir();

            writeFileSync(join(dir1, "file1.ts"), "export const a = 1;");
            writeFileSync(join(dir2, "file2.ts"), "export const b = 2;");

            const config1 = makeConfig({ baseDir: dir1 });
            const config2 = makeConfig({ baseDir: dir2 });
            const manager = await IndexerManager.load();

            try {
                const preExistingCount = manager.getIndexNames().length;

                await manager.addIndex(config1);
                await manager.addIndex(config2);

                const results = await manager.syncAll();
                expect(results.size).toBe(preExistingCount + 2);

                // Verify our two indexes were synced
                expect(results.has(config1.name)).toBe(true);
                expect(results.has(config2.name)).toBe(true);

                const stats1 = results.get(config1.name);
                const stats2 = results.get(config2.name);

                if (stats1) {
                    expect(stats1.filesScanned).toBeGreaterThan(0);
                }

                if (stats2) {
                    expect(stats2.filesScanned).toBeGreaterThan(0);
                }
            } finally {
                await manager.removeIndex(config1.name);
                await manager.removeIndex(config2.name);
                await manager.close();
                rmSync(dir1, { recursive: true, force: true });
                rmSync(dir2, { recursive: true, force: true });
            }
        },
        { timeout: 30_000 }
    );
});
