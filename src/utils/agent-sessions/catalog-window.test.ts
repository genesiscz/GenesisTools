import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import * as edgeLines from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader, codexHistoryReader, grokHistoryReader } from "./compact-readers";
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

test("an exact-path catalog refreshes and queries only the requested transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-catalog-paths-"));
    const ids = [
        "11111111-2222-4333-8444-000000000021",
        "11111111-2222-4333-8444-000000000022",
        "11111111-2222-4333-8444-000000000023",
    ];
    ids.forEach((id, index) => {
        session(root, id, (100 + index) * HOUR);
    });
    const filePaths = ids.slice(0, 2).map((id) => join(root, `${id}.jsonl`));
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);
    const metadata = spyOn(repository.metadata, "listMetadata");
    const stamps = new Set<string>();
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository,
        reader: claudeHistoryReader,
        now: () => new Date(NOW),
        freshness: {
            age: (key) => (stamps.has(key) ? 0 : null),
            touch: (key) => {
                stamps.add(key);
            },
        },
    });
    try {
        const limited = await service.catalog({ excludeAgents: true, filePaths }, { maxDiscoveryAgeMs: 30_000 });
        expect(limited.report.parsed).toBe(2);
        expect(limited.metadata.map((row) => row.sessionId).sort()).toEqual(ids.slice(0, 2));
        expect(metadata.mock.calls.every(([options]) => options.filePaths?.length === 2)).toBe(true);
        metadata.mockClear();
        const empty = await service.catalog({ excludeAgents: true, filePaths: [] });
        expect(empty.metadata).toEqual([]);
        expect(empty.report.parsed).toBe(0);
        // A narrow refresh cannot mark the whole provider fresh and hide the third session.
        const all = await service.catalog({ excludeAgents: true }, { maxDiscoveryAgeMs: 30_000 });
        expect(all.metadata.map((row) => row.sessionId).sort()).toEqual(ids);
        expect(all.report.parsed).toBe(1);
        metadata.mockClear();
        const cached = await service.catalog({ excludeAgents: true, filePaths }, { refresh: false });
        expect(cached.metadata.map((row) => row.sessionId).sort()).toEqual(ids.slice(0, 2));
        expect(metadata.mock.calls.every(([options]) => options.filePaths?.length === 2)).toBe(true);
    } finally {
        metadata.mockRestore();
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("an exact-path Codex catalog never walks history roots or reads unrelated headers", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "history-catalog-direct-")));
    const root = join(home, "sessions");
    mkdirSync(join(root, "nested"), { recursive: true });
    const ids = ["11111111-2222-4333-8444-000000000031", "11111111-2222-4333-8444-000000000032"];
    const paths = ids.map((id) => join(root, "nested", `rollout-${id}.jsonl`));
    paths.forEach((file, index) => {
        writeFileSync(
            file,
            `${SafeJSON.stringify({
                type: "session_meta",
                payload: {
                    id: ids[index],
                    cwd: "/projects/fixture",
                    history_mode: "legacy",
                },
            })}\n`
        );
    });
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "openai-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: codexHistoryReader,
    });
    const directories = spyOn(fsPromises, "readdir");
    const headers = spyOn(edgeLines, "readFirstLines");
    const discovery = spyOn(codexHistoryReader, "discover");
    try {
        const empty = await service.catalog({ filePaths: [] });
        expect(empty.metadata).toEqual([]);
        expect(discovery).toHaveBeenCalledTimes(0);
        expect(directories).toHaveBeenCalledTimes(0);
        expect(headers).toHaveBeenCalledTimes(0);
        const narrow = await service.catalog({ filePaths: [paths[0]] });
        expect(narrow.metadata.map((row) => row.sessionId)).toEqual([ids[0]]);
        expect(directories.mock.calls.filter(([directory]) => String(directory).startsWith(root))).toEqual([]);
        expect(headers.mock.calls.length).toBeGreaterThan(0);
        expect(headers.mock.calls.every(([file]) => file === paths[0])).toBe(true);
        directories.mockClear();
        headers.mockClear();
        discovery.mockClear();
        const cached = await service.catalog({ filePaths: [paths[0]] }, { refresh: false });
        expect(cached.metadata).toEqual(narrow.metadata);
        expect(discovery).toHaveBeenCalledTimes(0);
    } finally {
        directories.mockRestore();
        headers.mockRestore();
        discovery.mockRestore();
        database.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a logical project link refreshes directly without probing history directories", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "history-catalog-logical-link-")));
    const root = join(base, "projects");
    const project = join(root, "fixture");
    mkdirSync(project, { recursive: true });
    const id = "11111111-2222-4333-8444-000000000071";
    const outside = join(base, `${id}.jsonl`);
    writeFileSync(
        outside,
        `${SafeJSON.stringify({
            type: "user",
            sessionId: id,
            cwd: "/projects/fixture",
            message: { content: "linked prompt" },
        })}\n`
    );
    const logical = join(project, `${id}.jsonl`);
    symlinkSync(outside, logical);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: claudeHistoryReader,
    });
    const directories = spyOn(fsPromises, "readdir");
    try {
        const listing = await service.catalog({ excludeAgents: true, filePaths: [logical] });
        expect(listing.metadata.map((row) => row.sessionId)).toEqual([id]);
        expect(listing.report.parsed).toBe(1);
        expect(directories).toHaveBeenCalledTimes(0);
    } finally {
        directories.mockRestore();
        database.close();
        rmSync(base, { recursive: true, force: true });
    }
});

test.each([false, true])("exact-path keys survive a symlinked parent (deleted: %s)", async (deleted) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "history-catalog-parent-link-key-")));
    const root = join(base, "real");
    const alias = join(base, "alias");
    mkdirSync(root);
    symlinkSync(root, alias);
    const id = "11111111-2222-4333-8444-000000000081";
    session(root, id, HOUR);
    const canonical = join(root, `${id}.jsonl`);
    const logical = join(alias, `${id}.jsonl`);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository,
        reader: claudeHistoryReader,
    });
    try {
        const indexed = await service.catalog({ filePaths: [canonical] });
        expect(indexed.metadata.map((row) => row.filePath)).toEqual([canonical]);
        if (deleted) {
            rmSync(canonical);
        }

        const metadata = spyOn(repository.metadata, "listMetadata");
        try {
            const cached = await service.catalog({ filePaths: [logical] }, { refresh: false });
            expect(cached.metadata).toEqual(indexed.metadata);
            expect(metadata.mock.calls.every(([options]) => options.filePaths?.[0] === canonical)).toBe(true);
        } finally {
            metadata.mockRestore();
        }
    } finally {
        database.close();
        rmSync(base, { recursive: true, force: true });
    }
});

test("exact-path refresh prunes a deleted canonical transcript requested through a symlinked parent", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "history-catalog-parent-link-prune-")));
    const root = join(base, "real");
    const alias = join(base, "alias");
    mkdirSync(root);
    symlinkSync(root, alias);
    const id = "11111111-2222-4333-8444-000000000082";
    session(root, id, HOUR);
    const canonical = join(root, `${id}.jsonl`);
    const logical = join(alias, `${id}.jsonl`);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository,
        reader: claudeHistoryReader,
    });
    try {
        await service.catalog({ filePaths: [canonical] });
        expect(repository.sources("anthropic-sub").map((source) => source.filePath)).toEqual([canonical]);
        rmSync(canonical);
        const refreshed = await service.catalog({ filePaths: [logical] });
        expect(refreshed.report.removed).toBe(1);
        expect(refreshed.metadata).toEqual([]);
        expect(repository.sources("anthropic-sub")).toEqual([]);
        expect(repository.metadata.listMetadata({ providerId: "anthropic-sub" })).toEqual([]);
    } finally {
        database.close();
        rmSync(base, { recursive: true, force: true });
    }
});

test("exact-path refresh cannot prune unrelated cached sessions", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "history-catalog-exact-prune-")));
    const ids = ["11111111-2222-4333-8444-000000000041", "11111111-2222-4333-8444-000000000042"];
    ids.forEach((id) => {
        session(root, id, HOUR);
    });
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository,
        reader: claudeHistoryReader,
    });
    try {
        await service.catalog({});
        rmSync(join(root, `${ids[1]}.jsonl`));
        for (const excludeAgents of [undefined, true]) {
            const scoped = await service.catalog({
                filePaths: [join(root, `${ids[0]}.jsonl`)],
                excludeAgents,
                mtimeFrom: 0,
                newest: 2,
            });
            expect(scoped.metadata.map((row) => row.sessionId)).toEqual([ids[0]]);
            expect(repository.metadata.listMetadata({ providerId: "anthropic-sub" })).toHaveLength(2);
        }
        const missing = await service.catalog({ filePaths: [join(root, `${ids[1]}.jsonl`)] });
        expect(missing.metadata).toEqual([]);
        expect(repository.metadata.listMetadata({ providerId: "anthropic-sub" })).toHaveLength(1);
        const full = await service.catalog({});
        expect(full.metadata.map((row) => row.sessionId)).toEqual([ids[0]]);
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

function grokSession(root: string, id: string, ageMs: number): string {
    const directory = join(root, encodeURIComponent("/projects/shop"), id);
    const at = new Date(NOW - ageMs);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "chat_history.jsonl"),
        `${SafeJSON.stringify({ type: "user", timestamp: at.toISOString(), content: `<user_query>session ${id}</user_query>` }, { strict: true })}\n`
    );
    writeFileSync(
        join(directory, "summary.json"),
        SafeJSON.stringify(
            {
                info: { id, cwd: "/projects/shop" },
                created_at: at.toISOString(),
                updated_at: at.toISOString(),
            },
            { strict: true }
        )
    );
    utimesSync(join(directory, "chat_history.jsonl"), at, at);
    utimesSync(join(directory, "summary.json"), at, at);
    return directory;
}

test("a filtered windowed listing drops the row of a Grok session whose folder was deleted", async () => {
    const home = mkdtempSync(join(tmpdir(), "history-catalog-grok-gone-"));
    const root = join(home, "sessions");
    const kept = "aaaaaaaa-bbbb-4ccc-8ddd-000000000061";
    const deleted = "aaaaaaaa-bbbb-4ccc-8ddd-000000000062";
    grokSession(root, kept, HOUR);
    const deletedDirectory = grokSession(root, deleted, 2 * HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "grok-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: grokHistoryReader,
        now: () => new Date(NOW),
    });
    // The hub's listing: a filtered scope, so the root prune never runs for it.
    const listing = { excludeAgents: true, mtimeFrom: NOW - 24 * HOUR };

    try {
        const before = await service.catalog(listing);
        expect(before.metadata.map((entry) => entry.nativeId).sort()).toEqual([kept, deleted]);

        rmSync(deletedDirectory, { recursive: true, force: true });
        const after = await service.catalog(listing);

        expect(after.metadata.map((entry) => entry.nativeId)).toEqual([kept]);
        expect(after.report.removed).toBe(1);
    } finally {
        database.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a filtered windowed listing also drops a deleted session older than the window that its newest top-up showed", async () => {
    const home = mkdtempSync(join(tmpdir(), "history-catalog-grok-topup-"));
    const root = join(home, "sessions");
    const recent = "aaaaaaaa-bbbb-4ccc-8ddd-000000000081";
    const old = "aaaaaaaa-bbbb-4ccc-8ddd-000000000082";
    grokSession(root, recent, HOUR);
    const oldDirectory = grokSession(root, old, 48 * HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "grok-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: grokHistoryReader,
        now: () => new Date(NOW),
    });
    // The window holds one session; the top-up shows the newest ones whatever their age.
    const listing = { excludeAgents: true, mtimeFrom: NOW - 24 * HOUR, newest: 5 };

    try {
        const before = await service.catalog(listing);
        expect(before.metadata.map((entry) => entry.nativeId).sort()).toEqual([recent, old]);

        rmSync(oldDirectory, { recursive: true, force: true });
        const after = await service.catalog(listing);

        expect(after.metadata.map((entry) => entry.nativeId)).toEqual([recent]);
        expect(after.report.removed).toBe(1);
    } finally {
        database.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a filtered windowed listing keeps the rows of a root that is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "history-catalog-grok-unmounted-"));
    const root = join(home, "sessions");
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-000000000071";
    grokSession(root, id, HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);
    const service = new HistoryService({
        providerId: "grok-sub",
        roots: [root],
        repository,
        reader: grokHistoryReader,
        now: () => new Date(NOW),
    });
    const listing = { excludeAgents: true, mtimeFrom: NOW - 24 * HOUR };

    try {
        await service.catalog(listing);
        // A whole root that vanished is an unmounted volume or a moved home, not a deleted session.
        rmSync(root, { recursive: true, force: true });
        const after = await service.catalog(listing);

        expect(after.report.removed).toBe(0);
        expect(repository.sources("grok-sub").map((source) => source.filePath)).toHaveLength(1);
    } finally {
        database.close();
        rmSync(home, { recursive: true, force: true });
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

test("a refresh of a caller's own database never stamps the default index's refresh marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "history-catalog-marker-home-"));
    const root = mkdtempSync(join(tmpdir(), "history-catalog-marker-"));
    session(root, "11111111-2222-4333-8444-000000000031", HOUR);
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const markers = join(dirname(historyDatabasePath()), "listing-fresh");
    const database = new Database(":memory:");

    try {
        await openHistoryService({ provider: "claude", roots: [root], database }).catalog(
            {},
            { maxDiscoveryAgeMs: 30_000 }
        );
        expect(existsSync(markers)).toBe(false);

        // The default index still stamps it, so pollers keep sharing one refresh.
        await openHistoryService({ provider: "claude", roots: [root] }).catalog({}, { maxDiscoveryAgeMs: 30_000 });
        expect(existsSync(markers)).toBe(true);
    } finally {
        database.close();
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
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
