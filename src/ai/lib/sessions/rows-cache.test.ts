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
    sessionRowsJson,
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

describe("sessionRowsJson", () => {
    test("daemon fetches do not update the cache or request stamp; normal fresh requests still do", async () => {
        const path = await scratch();
        const original = entry();
        await writeSessionRowsCache(original, path);
        const answer = await sessionRowsJson(original.query, {
            fresh: true,
            cacheWrite: false,
            path,
            listRows: async () => [row(9)],
        });
        expect(answer.rows).toEqual([row(9)]);
        expect(answer.cached).toBe(false);
        expect(await readSessionRowsCache(path)).toEqual(original);
        await sessionRowsJson(original.query, { fresh: true, path, listRows: async () => [row(10)] });
        const updated = await readSessionRowsCache(path);
        expect(updated?.rows).toEqual([row(10)]);
        expect(updated?.lastRequestedAt).toBeGreaterThan(original.lastRequestedAt);
    });

    test("a cached answer carries cache clocks worked out for now, not for when the rows were built", async () => {
        const path = await scratch();
        const now = Date.now();
        const built = now - 80_000;
        const lastCacheAt = now - 3_600_000 + 30_000;
        const clocked: AgentSessionRow = {
            ...row(5),
            lastCacheAt,
            cacheLifetimeSec: 3600,
            cacheStatus: "CRITICAL",
            cacheTtlSec: 110,
        };
        await writeSessionRowsCache(
            { query: { hours: 24 }, fetchedAt: built, lastRequestedAt: now, rows: [clocked, row(6)] },
            path
        );
        const answer = await sessionRowsJson({ hours: 24 }, { path, liveLocations: false, listRows: async () => [] });

        expect(answer.cached).toBe(true);
        expect(answer.rows[0]?.cacheStatus).toBe("CRITICAL");
        expect(answer.rows[0]?.cacheTtlSec).toBeLessThanOrEqual(30);
        expect(answer.rows[1]).toEqual(row(6));

        await writeSessionRowsCache(
            {
                query: { hours: 24 },
                fetchedAt: built,
                lastRequestedAt: now,
                rows: [{ ...clocked, lastCacheAt: built - 3_600_000 + 60_000 }],
            },
            path
        );
        const cold = await sessionRowsJson({ hours: 24 }, { path, liveLocations: false, listRows: async () => [] });

        expect(cold.rows[0]).toMatchObject({ cacheStatus: "COLD", cacheTtlSec: 0 });
    });
});

describe("sessionRowsJson tmux locations", () => {
    const live = {
        workspaceId: "WS-UUID",
        workspaceRef: "workspace:1",
        paneRef: "pane:1",
        surfaceId: "S2-UUID",
        surfaceRef: "surface:2",
        windowRef: "window:1",
        at: 42,
    };

    test("a session that runs in tmux is served with its live cmux tab, and the cache file keeps the journal's answer", async () => {
        const path = await scratch();
        const tmuxLocations = async () => new Map([["s-9", live]]);
        const fresh = await sessionRowsJson(entry().query, {
            fresh: true,
            path,
            listRows: async () => [row(9), row(8)],
            tmuxLocations,
        });

        expect(fresh.rows.map((r) => r.cmux ?? null)).toEqual([live, null]);
        expect((await readSessionRowsCache(path))?.rows.map((r) => r.cmux ?? null)).toEqual([null, null]);

        const cached = await sessionRowsJson(entry().query, { path, listRows: async () => [], tmuxLocations });

        expect(cached.cached).toBe(true);
        expect(cached.rows.map((r) => r.cmux ?? null)).toEqual([live, null]);
    });

    test("a daemon refresh through the server caches the journal's answer, so a detached client is not shown its old tab", async () => {
        const path = await scratch();
        await writeSessionRowsCache({ ...entry(), lastRequestedAt: Date.now() }, path);
        const served = async () =>
            (
                await sessionRowsJson(entry().query, {
                    fresh: true,
                    cacheWrite: false,
                    liveLocations: false,
                    path,
                    listRows: async () => [row(9)],
                    tmuxLocations: async () => new Map([["s-9", live]]),
                })
            ).rows;
        await refreshSessionRowsCache(async () => [], { path, remote: served });

        expect((await readSessionRowsCache(path))?.rows.map((r) => r.cmux ?? null)).toEqual([null]);

        const detached = await sessionRowsJson(entry().query, {
            path,
            listRows: async () => [],
            tmuxLocations: async () => new Map(),
        });

        expect(detached.rows.map((r) => r.cmux ?? null)).toEqual([null]);
    });

    test("an unavailable tmux lookup serves the rows unchanged", async () => {
        const answer = await sessionRowsJson(entry().query, {
            fresh: true,
            path: await scratch(),
            listRows: async () => [row(9)],
            tmuxLocations: async () => {
                throw new Error("ps failed");
            },
        });

        expect(answer.rows).toEqual([row(9)]);
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

    test("takes the rows a warm process answers with, and still keeps lastRequestedAt; null falls back to listing", async () => {
        const path = await scratch();
        await writeSessionRowsCache(entry({ lastRequestedAt: 10_000, fetchedAt: 10_000 }), path);
        let listed = 0;
        const listRows = async () => {
            listed++;
            return [row(1)];
        };

        const served = await refreshSessionRowsCache(listRows, {
            now: 20_000,
            path,
            remote: async () => [row(7), row(8)],
        });
        expect(served).toEqual({ refreshed: true, reason: "refreshed", rows: 2, via: "server" });
        expect(listed).toBe(0);
        const stored = await readSessionRowsCache(path);
        expect(stored?.lastRequestedAt).toBe(10_000);
        expect(stored?.rows.map((item) => item.sessionId)).toEqual(["s-7", "s-8"]);

        const local = await refreshSessionRowsCache(listRows, { now: 30_000, path, remote: async () => null });
        expect(local).toEqual({ refreshed: true, reason: "refreshed", rows: 1, via: "local" });
        expect(listed).toBe(1);
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

        expect(result).toEqual({ refreshed: true, reason: "refreshed", rows: 1, via: "local" });
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
