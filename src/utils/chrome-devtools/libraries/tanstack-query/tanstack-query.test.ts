import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { SafeJSON } from "@genesiscz/utils/json";
import { querySummary } from "./in-page/query-summary.ts";
import { analyzePersistedClient, groupPersistedByPrefix } from "./persisted-client.ts";

function fakeQuery(queryKey: unknown[], data: unknown, extra: Record<string, unknown> = {}) {
    return {
        queryKey,
        queryHash: SafeJSON.stringify(queryKey, { strict: true }),
        state: { status: "success", fetchStatus: "idle", data, dataUpdatedAt: 1_700_000_000_000 },
        meta: undefined as unknown,
        getObserversCount: () => 2,
        isStale: () => false,
        ...extra,
    };
}

function runSummary(window: Record<string, unknown>, args: Record<string, unknown>) {
    return runInNewContext(`(${querySummary.toString()})(args)`, { window, args, TextEncoder });
}

describe("querySummary (in-page)", () => {
    test("survives toString() in a clean context", () => {
        const source = querySummary.toString();
        expect(source).not.toMatch(/__name\(|__require|__toESM|import\(/);
        expect(typeof runInNewContext(`(${source})`, {})).toBe("function");
    });

    test("reads key, status, observers, size and meta of every query, and the data of chosen prefixes", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const queries = [
            fakeQuery(["items", { page: 1 }], [{ name: "ž" }]),
            fakeQuery(["session"], { token: "x" }, { meta: { persist: false } }),
            fakeQuery(["broken"], circular, {
                getObserversCount: () => {
                    throw new Error("observer list torn down");
                },
            }),
        ];
        const window = {
            __qc: {
                getQueryCache: () => ({ getAll: () => queries }),
                getMutationCache: () => ({ getAll: () => [1, 2] }),
            },
        };

        const result = runSummary(window, { slot: "__qc", dataFor: ["items"] });

        expect(result.error).toBeUndefined();
        expect(result.mutations).toBe(2);
        expect(result.queries.map((row: { prefix: string }) => row.prefix)).toEqual(["items", "session", "broken"]);
        expect(result.queries[0]).toMatchObject({
            key: '["items",{"page":1}]',
            status: "success",
            observers: 2,
            dataBytes: new TextEncoder().encode('[{"name":"ž"}]').length,
            stale: false,
            meta: null,
        });
        expect(result.queries[1].meta).toEqual({ persist: false });
        expect(result.queries[2].dataBytes).toBe(-1);
        expect(result.queries[2].observers).toBe(-1);
        expect(result.data).toEqual([{ key: '["items",{"page":1}]', data: [{ name: "ž" }] }]);
    });

    test("reports a missing client instead of throwing", () => {
        expect(runSummary({}, { slot: "__qc" }).error).toBe("window.__qc holds no QueryClient");
    });
});

describe("analyzePersistedClient", () => {
    const queries = [
        {
            queryKey: ["codebook", { id: "ERRORS" }],
            queryHash: "a",
            state: { data: [{ from: "2026-01-01" }], dataUpdatedAt: 1, status: "success" },
        },
        { queryKey: ["user"], queryHash: "b", state: { data: { name: "Test" }, dataUpdatedAt: 2, status: "success" } },
    ];

    test("attributes superjson meta paths to their query", () => {
        const meta = { values: { "clientState.queries.0.state.data.0.from": ["Date"], "buster.other": ["undefined"] } };
        const raw = SafeJSON.stringify(
            {
                json: { buster: "v1", timestamp: 5, clientState: { queries, mutations: [] } },
                meta,
            },
            { strict: true }
        );

        const analysis = analyzePersistedClient(raw);

        expect(analysis.encoding).toBe("superjson");
        expect(analysis.buster).toBe("v1");
        expect(analysis.queries).toHaveLength(2);
        const share =
            "clientState.queries.0.state.data.0.from".length +
            SafeJSON.stringify(["Date"], { strict: true }).length +
            4;
        expect(analysis.queries[0].superjsonMetaBytes).toBe(share);
        expect(analysis.queries[0].totalBytes).toBe(SafeJSON.stringify(queries[0], { strict: true }).length + share);
        expect(analysis.queries[0].arrayLength).toBe(1);
        expect(analysis.queries[1].superjsonMetaBytes).toBe(0);
        expect(analysis.queries[1].topLevelKeys).toEqual(["name"]);
        expect(analysis.superjsonMetaBytes).toBe(SafeJSON.stringify(meta, { strict: true }).length);
        expect(analysis.unattributedMetaBytes).toBe(SafeJSON.stringify(meta, { strict: true }).length - share);
        expect(analysis.bytes).toBe(raw.length);
    });

    test("reads a plain JSON client and groups by prefix", () => {
        const raw = SafeJSON.stringify(
            { buster: "", timestamp: 1, clientState: { queries: [...queries, queries[1]] } },
            { strict: true }
        );

        const analysis = analyzePersistedClient(raw);
        const groups = groupPersistedByPrefix(analysis.queries);

        expect(analysis.encoding).toBe("json");
        expect(analysis.superjsonMetaBytes).toBe(0);
        expect(Object.fromEntries(groups.map((group) => [group.prefix, group.entries]))).toEqual({
            codebook: 1,
            user: 2,
        });
        expect(groups[0].totalBytes).toBeGreaterThanOrEqual(groups[1].totalBytes);
        expect(groups.reduce((sum, group) => sum + group.share, 0)).toBeCloseTo(1, 6);
    });

    test("rejects a value that is not a persisted client", () => {
        expect(() => analyzePersistedClient('{"x":1}')).toThrow("no clientState");
    });
});
