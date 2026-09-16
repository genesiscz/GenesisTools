import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRow, AgentSessionRowsOptions } from "./agent-session-rows";
import {
    cacheIsUsable,
    readSessionRowsCache,
    refreshSessionRowsCache,
    SESSION_ROWS_KEEP_WARM_MS,
    SESSION_ROWS_MAX_AGE_MS,
    type SessionRowsCache,
    sessionRowsCacheKey,
    writeSessionRowsCache,
} from "./rows-cache";

const dirs: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "gt-rows-cache-"));
    dirs.push(dir);

    return join(dir, "usage-sessions.json");
}

function row(mtime: number): AgentSessionRow {
    return {
        provider: "claude",
        sessionId: `s-${mtime}`,
        title: null,
        cwd: "/tmp",
        cwdShort: "/tmp",
        project: null,
        mtime,
        model: null,
        account: null,
        filePath: "/tmp/s.jsonl",
    };
}

function entry(over: Partial<SessionRowsCache> = {}): SessionRowsCache {
    return { query: { hours: 24, minRows: 10 }, fetchedAt: 1_000, lastRequestedAt: 1_000, rows: [row(5)], ...over };
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sessionRowsCacheKey", () => {
    test("provider order does not change the query identity", () => {
        expect(sessionRowsCacheKey({ providers: ["grok", "claude"] })).toBe(
            sessionRowsCacheKey({ providers: ["claude", "grok"] })
        );
    });

    test("a different window is a different query", () => {
        expect(sessionRowsCacheKey({ hours: 1 })).not.toBe(sessionRowsCacheKey({ hours: 24 }));
    });
});

describe("cacheIsUsable", () => {
    test("rejects rows computed for another query", () => {
        expect(cacheIsUsable(entry(), sessionRowsCacheKey({ hours: 1 }), 1_000)).toBe(false);
    });

    test("rejects rows older than the window", () => {
        const key = sessionRowsCacheKey({ hours: 24, minRows: 10 });

        expect(cacheIsUsable(entry(), key, 1_000 + SESSION_ROWS_MAX_AGE_MS + 1)).toBe(false);
        expect(cacheIsUsable(entry(), key, 1_000 + SESSION_ROWS_MAX_AGE_MS)).toBe(true);
    });

    test("a missing file is a miss", () => {
        expect(cacheIsUsable(null, sessionRowsCacheKey({}), 0)).toBe(false);
    });
});

describe("read and write", () => {
    test("round-trips the query and the rows", async () => {
        const path = await scratch();
        await writeSessionRowsCache(entry(), path);

        expect(await readSessionRowsCache(path)).toEqual(entry());
    });

    test("a corrupt file is a miss, not a throw", async () => {
        const path = await scratch();
        await Bun.write(path, "{ not json");

        expect(await readSessionRowsCache(path)).toBeNull();
    });

    test("an absent file is a miss", async () => {
        expect(await readSessionRowsCache(await scratch())).toBeNull();
    });

    test("a JSON file with query: null is a miss, not a throw", async () => {
        const path = await scratch();
        await Bun.write(path, '{"query":null,"fetchedAt":1,"lastRequestedAt":1,"rows":[]}');

        expect(await readSessionRowsCache(path)).toBeNull();
    });
});

describe("refreshSessionRowsCache", () => {
    test("does not walk anything before a query has been asked", async () => {
        let calls = 0;
        const result = await refreshSessionRowsCache(
            async () => {
                calls++;
                return [];
            },
            { path: await scratch() }
        );

        expect(calls).toBe(0);
        expect(result).toEqual({ refreshed: false, reason: "no query has been asked yet" });
    });

    test("recomputes the stored query and keeps lastRequestedAt", async () => {
        const path = await scratch();
        const seen: AgentSessionRowsOptions[] = [];
        await writeSessionRowsCache(entry({ lastRequestedAt: 10_000, fetchedAt: 10_000 }), path);

        const result = await refreshSessionRowsCache(
            async (options) => {
                seen.push(options);
                return [row(99)];
            },
            { now: 20_000, path }
        );

        expect(result).toEqual({ refreshed: true, reason: "refreshed", rows: 1 });
        expect(seen).toEqual([{ hours: 24, minRows: 10 }]);

        const stored = await readSessionRowsCache(path);

        expect(stored?.fetchedAt).toBe(20_000);
        expect(stored?.lastRequestedAt).toBe(10_000);
        expect(stored?.rows[0]?.sessionId).toBe("s-99");
    });

    test("stops once nobody has asked for an hour", async () => {
        const path = await scratch();
        let calls = 0;
        await writeSessionRowsCache(entry({ lastRequestedAt: 0 }), path);

        const result = await refreshSessionRowsCache(
            async () => {
                calls++;
                return [];
            },
            { now: SESSION_ROWS_KEEP_WARM_MS + 1, path }
        );

        expect(calls).toBe(0);
        expect(result.refreshed).toBe(false);
        expect(result.reason).toBe("nobody has asked for an hour");
    });
});
