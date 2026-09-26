import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader } from "./compact-readers";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryService } from "./service";
import { HistorySyncRepository } from "./sync-repository";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-16T20:00:00Z");

function session(root: string, id: string, ageMs: number): void {
    const file = join(root, `${id}.jsonl`);
    writeFileSync(
        file,
        `${SafeJSON.stringify({ type: "user", sessionId: id, cwd: "/projects/fixture", timestamp: new Date(NOW - ageMs).toISOString(), message: { content: `session ${id}` } })}\n`
    );
    utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
}

test("a windowed catalog refreshes and returns the window plus the newest top-up, never the whole corpus", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-catalog-window-"));
    const fresh = "11111111-2222-4333-8444-000000000001";
    const recent = "11111111-2222-4333-8444-000000000002";
    const old = "11111111-2222-4333-8444-000000000003";
    session(root, fresh, HOUR);
    session(root, recent, 2 * 24 * HOUR);
    session(root, old, 30 * 24 * HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: claudeHistoryReader,
        now: () => new Date(NOW),
    });

    try {
        const windowed = await service.catalog({ mtimeFrom: NOW - 24 * HOUR });
        expect(windowed.metadata.map((entry) => entry.nativeId)).toEqual([fresh]);
        // Only the window was parsed: the corpus holds three sessions, one is inside the window.
        expect(windowed.report.parsed).toBe(1);

        const toppedUp = await service.catalog({ mtimeFrom: NOW - 24 * HOUR, newest: 2 });
        expect(toppedUp.metadata.map((entry) => entry.nativeId)).toEqual([fresh, recent]);
        expect(toppedUp.report.parsed).toBe(1);

        const everything = await service.catalog({});
        expect(everything.metadata.map((entry) => entry.nativeId).sort()).toEqual([fresh, recent, old].sort());
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a filtered windowed catalog reads only the rows of the sources it refreshes", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-catalog-narrow-"));
    const fresh = "11111111-2222-4333-8444-000000000011";
    const old = "11111111-2222-4333-8444-000000000012";
    session(root, fresh, HOUR);
    session(root, old, 30 * 24 * HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const reads = { all: 0, paths: [] as string[][] };

    class CountingRepository extends HistorySyncRepository {
        override sources(providerId: string) {
            reads.all++;
            return super.sources(providerId);
        }

        override sourcesForPaths(options: { providerId: string; filePaths: Iterable<string> }) {
            const filePaths = [...options.filePaths];
            reads.paths.push(filePaths);
            return super.sourcesForPaths({ providerId: options.providerId, filePaths });
        }
    }

    const repository = new CountingRepository(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository,
        reader: claudeHistoryReader,
        now: () => new Date(NOW),
    });

    try {
        // Unfiltered: the prune pass needs every row, so the full read still happens.
        await service.catalog({});
        expect(reads.all).toBeGreaterThan(0);
        reads.all = 0;
        reads.paths = [];

        // The live session grows: a real refresh, with its write pass.
        writeFileSync(
            join(root, `${fresh}.jsonl`),
            `${SafeJSON.stringify({ type: "user", sessionId: fresh, cwd: "/projects/fixture", timestamp: new Date(NOW).toISOString(), message: { content: "grown" } })}\n`,
            { flag: "a" }
        );
        const grown = await service.catalog({ excludeAgents: true, mtimeFrom: NOW - 24 * HOUR });
        expect(grown.report.parsed).toBe(1);
        expect(grown.metadata.map((entry) => entry.nativeId)).toEqual([fresh]);
        expect(reads.all).toBe(0);
        expect(reads.paths.length).toBeGreaterThan(0);
        expect(reads.paths.every((paths) => paths.every((path) => path.endsWith(`${fresh}.jsonl`)))).toBe(true);

        // The narrowed read returns exactly the full read's rows for those paths.
        const freshPath = reads.paths[0][0];
        expect(repository.sourcesForPaths({ providerId: "anthropic-sub", filePaths: [freshPath] })).toEqual(
            repository.metadata.listSources("anthropic-sub").filter((source) => source.filePath === freshPath)
        );

        // The SQL root check agrees with `historyPathUnderRoot`: a sibling sharing the prefix is not under it.
        const under = (candidate: string) =>
            repository.hasSourcesUnder({ providerId: "anthropic-sub", root: candidate });
        const canonical = realpathSync(root);
        expect([
            under(canonical),
            under(freshPath),
            under(`${canonical}-sibling`),
            under(canonical.slice(0, -1)),
        ]).toEqual([true, true, false, false]);
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a catalog with maxDiscoveryAgeMs reuses a recent refresh of the same scope and walks once it is older", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-catalog-fresh-"));
    const id = "11111111-2222-4333-8444-000000000021";
    session(root, id, HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const stamps = new Map<string, number>();
    let clock = 1_000_000;
    let walks = 0;
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: {
            ...claudeHistoryReader,
            discover: (roots, options) => {
                walks++;
                return claudeHistoryReader.discover(roots, options);
            },
        },
        now: () => new Date(NOW),
        freshness: {
            age: (key) => (stamps.has(key) ? clock - (stamps.get(key) ?? 0) : null),
            touch: (key) => {
                stamps.set(key, clock);
            },
        },
    });

    try {
        // A caller without the option always refreshes, and its refresh stamps the scope.
        await service.catalog({ excludeAgents: true, mtimeFrom: NOW - 24 * HOUR });
        expect(walks).toBe(1);

        clock += 10_000;
        const reused = await service.catalog(
            { excludeAgents: true, mtimeFrom: NOW - 72 * HOUR },
            { maxDiscoveryAgeMs: 30_000 }
        );
        expect(walks).toBe(1);
        expect(reused.metadata.map((entry) => entry.nativeId)).toEqual([id]);
        expect(reused.report.parsed).toBe(0);

        // Another scope is another stamp.
        await service.catalog({ agentsOnly: true }, { maxDiscoveryAgeMs: 30_000 });
        expect(walks).toBe(2);

        clock += 30_000;
        await service.catalog({ excludeAgents: true, mtimeFrom: NOW - 72 * HOUR }, { maxDiscoveryAgeMs: 30_000 });
        expect(walks).toBe(3);
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});
