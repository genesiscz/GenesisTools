import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader } from "./compact-readers";
import { HistoryDatabase, historyDatabasePath } from "./database";
import { initializeCompactHistorySchema, initializeHistorySchema } from "./migrations";
import { catalogHistory, openHistoryService } from "./open-service";
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

test("a catalog with refresh: false reads the index as it is and never walks, while an ordinary catalog still does", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-catalog-unrefreshed-"));
    const id = "11111111-2222-4333-8444-000000000031";
    session(root, id, HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    let forbidden = true;
    let walks = 0;
    const stamps: string[] = [];
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: {
            ...claudeHistoryReader,
            discover: (roots, options) => {
                walks++;

                if (forbidden) {
                    throw new Error("a refresh: false catalog walked the sources");
                }

                return claudeHistoryReader.discover(roots, options);
            },
        },
        now: () => new Date(NOW),
        freshness: {
            age: () => null,
            touch: (key) => {
                stamps.push(key);
            },
        },
    });

    try {
        // Never refreshed, and no recent refresh to reuse: it still reads the (empty) index as it is.
        const empty = await service.catalog({ excludeAgents: true }, { refresh: false });
        expect(walks).toBe(0);
        expect(stamps).toEqual([]);
        expect(empty.metadata).toEqual([]);

        forbidden = false;
        const refreshed = await service.catalog({ excludeAgents: true });
        expect(walks).toBe(1);
        expect(refreshed.metadata.map((entry) => entry.nativeId)).toEqual([id]);

        forbidden = true;
        const read = await service.catalog({ excludeAgents: true }, { refresh: false });
        expect(walks).toBe(1);
        expect(read.metadata.map((entry) => entry.nativeId)).toEqual([id]);
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("catalogHistory with refresh: false creates no index when none exists, and reads an existing one without writing it", async () => {
    const home = mkdtempSync(join(tmpdir(), "history-catalog-readonly-home-"));
    const root = mkdtempSync(join(tmpdir(), "history-catalog-readonly-"));
    const id = "11111111-2222-4333-8444-000000000041";
    session(root, id, HOUR);
    env.testing.set("GENESIS_TOOLS_HOME", home);

    try {
        const nothing = await catalogHistory({ provider: "claude", roots: [root], filters: {}, refresh: false });
        expect(nothing.metadata).toEqual([]);
        expect(existsSync(historyDatabasePath())).toBe(false);

        // The ordinary path still creates and fills the index.
        const built = await openHistoryService({ provider: "claude", roots: [root] }).catalog({});
        expect(built.metadata.map((entry) => entry.nativeId)).toEqual([id]);
        HistoryDatabase.closeInstance();
        const before = readFileSync(historyDatabasePath());

        const read = await catalogHistory({ provider: "claude", roots: [root], filters: {}, refresh: false });
        expect(read.metadata.map((entry) => entry.nativeId)).toEqual([id]);
        expect(readFileSync(historyDatabasePath()).equals(before)).toBe(true);
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test("catalogHistory with refresh: false lists nothing from an index that still needs a migration, and does not migrate it", async () => {
    const home = mkdtempSync(join(tmpdir(), "history-catalog-premigration-home-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    try {
        // An index written before the compact migrations: the old schema, none of the compact columns.
        mkdirSync(dirname(historyDatabasePath()), { recursive: true });
        const old = new Database(historyDatabasePath());
        initializeHistorySchema(old);
        old.close();
        const before = readFileSync(historyDatabasePath());

        const listed = await catalogHistory({ provider: "claude", filters: {}, refresh: false });
        expect(listed.metadata).toEqual([]);
        expect(readFileSync(historyDatabasePath()).equals(before)).toBe(true);
    } finally {
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(home, { recursive: true, force: true });
    }
});

test("catalogHistory with refresh: false still lists an index whose only pending migration adds an index", async () => {
    const home = mkdtempSync(join(tmpdir(), "history-catalog-indexonly-home-"));
    const root = mkdtempSync(join(tmpdir(), "history-catalog-indexonly-"));
    const id = "11111111-2222-4333-8444-000000000051";
    session(root, id, HOUR);
    env.testing.set("GENESIS_TOOLS_HOME", home);

    try {
        await openHistoryService({ provider: "claude", roots: [root] }).catalog({});
        HistoryDatabase.closeInstance();
        const db = new Database(historyDatabasePath());
        db.exec("DROP INDEX idx_session_metadata_provider_mtime");
        db.run("DELETE FROM _migrations WHERE id = ?", ["provider_history:2026-09-history-metadata-mtime-index"]);
        db.close();
        const before = readFileSync(historyDatabasePath());

        const listed = await catalogHistory({ provider: "claude", roots: [root], filters: {}, refresh: false });
        expect(listed.metadata.map((entry) => entry.nativeId)).toEqual([id]);
        expect(readFileSync(historyDatabasePath()).equals(before)).toBe(true);
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});
