import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { HistoryDatabase, historyDatabasePath } from "./database";
import { createNativeHistoryAdapter, nativeReaderFor } from "./native-adapter";

afterEach(() => {
    HistoryDatabase.closeInstance();
    env.testing.unset("GENESIS_TOOLS_HOME");
});

test("registered Codex reader powers the compatibility adapter and index status", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-native-adapter-"));
    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    writeFileSync(
        join(sessions, "rollout-11111111-2222-4333-8444-555555555555.jsonl"),
        [
            { type: "session_meta", payload: { id: "11111111-2222-4333-8444-555555555555", cwd: "/projects/shop" } },
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "beyond the first prompt" }],
                },
            },
        ]
            .map((row) => SafeJSON.stringify(row))
            .join("\n")
    );
    const db = new Database(":memory:");
    try {
        const adapter = createNativeHistoryAdapter({ kind: "codex", roots: [sessions], database: db });
        expect(nativeReaderFor("codex").kind).toBe("codex");
        expect(nativeReaderFor("codex").importSession).toBeDefined();
        expect(await adapter.search({ query: "beyond" })).toHaveLength(1);
        expect((await adapter.sync?.())?.parsed).toBe(0);
        expect((await adapter.status?.())?.messages).toBeNull();
    } finally {
        db.close();
    }
});

test("status does not create or migrate an absent native index", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-native-status-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    try {
        const adapter = createNativeHistoryAdapter({ kind: "codex", roots: [] });
        const status = await adapter.status?.();
        expect(status?.sessions).toBe(0);
        expect(status?.messages).toBeNull();
        expect(existsSync(join(home, ".genesis-tools", "claude-history"))).toBe(false);
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
    const db = new Database(":memory:");
    try {
        const adapter = createNativeHistoryAdapter({ kind: "codex", roots: [], database: db });
        await adapter.status?.();
        expect(db.query("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get()).toEqual({
            count: 0,
        });
    } finally {
        db.close();
    }
});

test("history synchronization protects transcript index files and existing SQLite sidecars", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-native-private-"));
    const directory = join(home, ".genesis-tools", "claude-history");
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(directory, 0o755);
    const path = join(directory, "index.db");
    const existing = new Database(path);
    existing.run("PRAGMA journal_mode = WAL");
    existing.run("CREATE TABLE fixture (value TEXT)");
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        chmodSync(file, 0o644);
    }
    env.testing.set("GENESIS_TOOLS_HOME", home);
    try {
        await createNativeHistoryAdapter({ kind: "codex", roots: [] }).sync?.();
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        for (const file of [path, `${path}-wal`, `${path}-shm`]) {
            expect(statSync(file).mode & 0o777).toBe(0o600);
        }
    } finally {
        existing.close();
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
});

test("canonical adapter searches Codex and Grok originals, refreshes appends, and stores no transcript mirrors", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-native-canonical-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    const codexRoot = join(home, "codex-sessions");
    mkdirSync(codexRoot);
    const codexPath = join(codexRoot, "rollout-11111111-2222-4333-8444-555555555555.jsonl");
    const codexOriginal = SafeJSON.stringify({
        type: "response_item",
        timestamp: "2026-09-01T10:01:00.000Z",
        payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "CODEX_ORIGINAL_MATCH" }],
        },
    });
    writeFileSync(
        codexPath,
        [
            SafeJSON.stringify({
                type: "session_meta",
                timestamp: "2026-09-01T10:00:00.000Z",
                payload: {
                    id: "11111111-2222-4333-8444-555555555555",
                    cwd: "/projects/shop",
                    history_mode: "legacy",
                },
            }),
            codexOriginal,
        ].join("\n")
    );

    const grokRoot = join(home, "grok-sessions");
    const grokDirectory = join(grokRoot, encodeURIComponent("/projects/shop"), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    mkdirSync(grokDirectory, { recursive: true });
    const grokPath = join(grokDirectory, "chat_history.jsonl");
    const grokOriginal = SafeJSON.stringify({
        type: "assistant",
        timestamp: "2026-09-01T10:02:00.000Z",
        content: [{ type: "text", text: "GROK_ORIGINAL_MATCH" }],
    });
    writeFileSync(grokPath, grokOriginal);

    try {
        const codex = createNativeHistoryAdapter({ kind: "codex", roots: [codexRoot] });
        const grok = createNativeHistoryAdapter({ kind: "grok", roots: [grokRoot] });

        const codexHits = await codex.search({ query: "CODEX_ORIGINAL_MATCH" });
        const grokHits = await grok.search({ query: "GROK_ORIGINAL_MATCH" });
        expect(codexHits[0]?.sourceRecords?.map((record) => record.data)).toEqual([codexOriginal]);
        expect(grokHits[0]?.sourceRecords?.map((record) => record.data)).toEqual([grokOriginal]);

        const appendedOriginal = SafeJSON.stringify({
            type: "response_item",
            timestamp: "2026-09-01T10:03:00.000Z",
            payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "CODEX_APPENDED_MATCH" }],
            },
        });
        appendFileSync(codexPath, `\n${appendedOriginal}`);
        const refreshed = await codex.search({ query: "CODEX_APPENDED_MATCH" });
        expect(refreshed[0]?.sourceRecords?.map((record) => record.data)).toEqual([appendedOriginal]);
        expect((await codex.status?.())?.messages).toBeNull();

        HistoryDatabase.closeInstance();
        const canonical = new Database(historyDatabasePath(), { readonly: true });
        try {
            const tableNames = canonical
                .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map((row) => row.name);
            expect(tableNames).not.toContain("messages");
            expect(tableNames).not.toContain("raw_records");
            expect(tableNames.filter((name) => name.toLowerCase().includes("fts"))).toEqual([]);
        } finally {
            canonical.close();
        }
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
});

function codexSession(directory: string, id: string, text: string): void {
    writeFileSync(
        join(directory, `rollout-${id}.jsonl`),
        [
            { type: "session_meta", payload: { id, cwd: "/projects/shop" } },
            {
                type: "response_item",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
            },
        ]
            .map((row) => SafeJSON.stringify(row))
            .join("\n")
    );
}

// The cmux livelock rescue calls this while the machine is wedged. Discovering thousands of source
// files or opening a write transaction on the shared database is exactly what it cannot afford.
test("listCached reads only what is indexed and leaves the database byte-identical", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-native-cached-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const sessions = join(home, "codex-sessions");
    mkdirSync(sessions);
    codexSession(sessions, "11111111-2222-4333-8444-555555555555", "indexed already");

    try {
        const adapter = createNativeHistoryAdapter({ kind: "codex", roots: [sessions] });
        expect(await adapter.list({ all: true })).toHaveLength(1);
        HistoryDatabase.closeInstance();

        codexSession(sessions, "22222222-3333-4444-8555-666666666666", "never discovered");
        const path = historyDatabasePath();
        const before = createHash("sha256").update(readFileSync(path)).digest("hex");

        const cached = await adapter.listCached?.({ all: true });

        expect(cached?.map((session) => session.sessionId)).toEqual(["11111111-2222-4333-8444-555555555555"]);
        expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
        expect(await adapter.list({ all: true })).toHaveLength(2);
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
});

test("listCached reports nothing rather than creating an index that does not exist yet", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-native-cached-absent-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    try {
        const adapter = createNativeHistoryAdapter({ kind: "codex", roots: [] });
        expect(await adapter.listCached?.({ all: true })).toEqual([]);
        expect(existsSync(join(home, ".genesis-tools", "claude-history"))).toBe(false);
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
});

test("a date range filters a session even when no record carries a timestamp", async () => {
    // The listing date gate was skipped whenever `firstTimestamp` was null, which is every grok
    // session and any codex rollout without record timestamps. `--since 2027-01-01` then listed
    // sessions from 2026. The session-level overlap test falls back to the file mtime.
    const home = mkdtempSync(join(tmpdir(), "gt-native-dates-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const sessions = join(home, "codex-sessions");
    mkdirSync(sessions);
    const id = "11111111-2222-4333-8444-555555555555";
    const path = join(sessions, `rollout-${id}.jsonl`);
    writeFileSync(
        path,
        [
            { type: "session_meta", payload: { id, cwd: "/projects/shop" } },
            {
                type: "response_item",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "undated" }] },
            },
        ]
            .map((row) => SafeJSON.stringify(row))
            .join("\n")
    );
    utimesSync(path, new Date("2026-09-01T10:00:00.000Z"), new Date("2026-09-01T10:00:00.000Z"));

    try {
        const adapter = createNativeHistoryAdapter({ kind: "codex", roots: [sessions] });

        expect(await adapter.list({ all: true })).toHaveLength(1);
        expect(await adapter.list({ all: true, since: new Date("2027-01-01T00:00:00.000Z") })).toHaveLength(0);
        expect(await adapter.list({ all: true, until: new Date("2020-01-01T00:00:00.000Z") })).toHaveLength(0);
        expect(await adapter.list({ all: true, since: new Date("2020-01-01T00:00:00.000Z") })).toHaveLength(1);
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
});

test("a listing serves cached rows when another process holds the index", async () => {
    // A metadata refresh takes a write lock, which base never did on a warm index, so under a
    // held `BEGIN IMMEDIATE` this failed outright with `database is locked` after the 5 s busy
    // timeout where base returned results. Stale rows with a notice beat both that and a hang.
    const home = mkdtempSync(join(tmpdir(), "gt-native-busy-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const sessions = join(home, "codex-sessions");
    mkdirSync(sessions);
    codexSession(sessions, "11111111-2222-4333-8444-555555555555", "indexed before the lock");

    try {
        const adapter = createNativeHistoryAdapter({ kind: "codex", roots: [sessions] });
        expect(await adapter.list({ all: true })).toHaveLength(1);
        HistoryDatabase.closeInstance();

        // A second connection holds a write transaction for longer than the busy timeout.
        const blocker = new Database(historyDatabasePath());
        blocker.run("PRAGMA busy_timeout = 100");
        blocker.run("BEGIN IMMEDIATE");

        try {
            codexSession(sessions, "22222222-3333-4444-8555-666666666666", "never indexed");
            const listed = await adapter.list({ all: true });

            expect(listed.map((session) => session.sessionId)).toEqual(["11111111-2222-4333-8444-555555555555"]);
        } finally {
            blocker.run("ROLLBACK");
            blocker.close();
        }
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
}, 30_000);

function claudeSession(directory: string, id: string, timestamp: string, text: string): string {
    const path = join(directory, `${id}.jsonl`);
    writeFileSync(
        path,
        `${SafeJSON.stringify({
            type: "user",
            sessionId: id,
            cwd: "/projects/shop",
            timestamp,
            message: { role: "user", content: text },
        })}\n`
    );

    return path;
}

test("a limited search returns the newest sessions by timestamp, not by file mtime", async () => {
    // The wave loop cuts the scan by file mtime while the result is ordered by session timestamp,
    // so the two agree only by correlation. On the live index they agree to 100/100 at the top and
    // first diverge around 300, but a session whose file was touched long after its last message
    // is exactly the shape that breaks it.
    const home = mkdtempSync(join(tmpdir(), "gt-native-wave-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const projects = join(home, "projects");
    const directory = join(projects, "-projects-shop");
    mkdirSync(directory, { recursive: true });

    // Old content, freshly touched file.
    const stale = claudeSession(
        directory,
        "11111111-2222-4333-8444-555555555555",
        "2026-01-01T10:00:00.000Z",
        "wave needle"
    );
    utimesSync(stale, new Date("2026-09-08T00:00:00.000Z"), new Date("2026-09-08T00:00:00.000Z"));
    // Recent content, long-untouched file.
    const recent = claudeSession(
        directory,
        "22222222-3333-4444-8555-666666666666",
        "2026-09-01T10:00:00.000Z",
        "wave needle"
    );
    utimesSync(recent, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

    try {
        const adapter = createNativeHistoryAdapter({ kind: "claude", roots: [projects] });
        const all = await adapter.search({ query: "wave needle", all: true });
        const limited = await adapter.search({ query: "wave needle", all: true, limit: 1 });

        expect(all).toHaveLength(2);
        expect(limited).toHaveLength(1);
        // The unlimited search orders by session timestamp, so a limit of one must return its head.
        expect(limited[0]?.sessionId).toBe(all[0]?.sessionId);
        expect(limited[0]?.sessionId).toBe("22222222-3333-4444-8555-666666666666");
    } finally {
        HistoryDatabase.closeInstance();
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
}, 30_000);
