import { beforeEach, describe, expect, mock, test } from "bun:test";
import { registerUsageCommand } from "@app/claude/commands/usage";
import type { SessionMetadataRecord } from "@genesiscz/utils/claude/history-cache";
import { Command } from "commander";

const MIN = 60 * 1000;
const listing: { sessions: SessionMetadataRecord[] } = { sessions: [] };
const tails = new Map<string, string[]>();

mock.module("@app/claude/lib/history/search", () => ({
    getSessionListing: async () => ({
        sessions: listing.sessions,
        total: listing.sessions.length,
        subagents: 0,
        indexed: 0,
        staleRemoved: 0,
        reindexed: false,
        projectCount: 1,
        scope: "test",
    }),
}));

mock.module("@genesiscz/utils/claude/session.utils", () => ({
    readTailBytes: async (filePath: string) => tails.get(filePath) ?? [],
}));

const pins = new Map<string, { account: string | null }>();
const cmuxRefs = new Map<string, { surfaceId: string | null; at: number }>();

mock.module("@app/claude/lib/cmux/pins", () => ({
    loadPins: async () => pins,
}));

mock.module("@app/claude/lib/cmux/session-refs", () => ({
    loadAllSessionCmuxRefs: () => cmuxRefs,
}));

import {
    CACHE_TTL_MS,
    COOLING_THRESHOLD_MS,
    CRITICAL_THRESHOLD_MS,
    computeCacheStatus,
    listSessionRows,
    listSessionRowsWithTimings,
} from "./session-rows";

const NOW = 1_700_000_000_000;

function record(
    overrides: Partial<SessionMetadataRecord> & Pick<SessionMetadataRecord, "filePath" | "mtime">
): SessionMetadataRecord {
    return {
        sessionId: overrides.sessionId ?? "sess",
        customTitle: overrides.customTitle ?? "title",
        summary: null,
        firstPrompt: "prompt",
        gitBranch: null,
        project: "GenesisTools",
        cwd: "/tmp/project",
        firstTimestamp: null,
        isSubagent: false,
        allUserText: null,
        ...overrides,
    };
}

const OPUS_LINE =
    '{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":100,"cache_creation_input_tokens":5}}}';
const SONNET_LINE =
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}';
const FABLE_LINE =
    '{"type":"assistant","message":{"model":"claude-fable-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}';

describe("computeCacheStatus", () => {
    test("now - 0 is HOT", () => {
        expect(computeCacheStatus(NOW, NOW).status).toBe("HOT");
    });

    test("now - 51min is COOLING", () => {
        expect(computeCacheStatus(NOW - 51 * MIN, NOW).status).toBe("COOLING");
    });

    test("now - 56min is CRITICAL", () => {
        expect(computeCacheStatus(NOW - 56 * MIN, NOW).status).toBe("CRITICAL");
    });

    test("now - 61min is COLD", () => {
        expect(computeCacheStatus(NOW - 61 * MIN, NOW).status).toBe("COLD");
    });

    test("thresholds are 50min cooling, 55min critical, 60min cold", () => {
        expect(computeCacheStatus(NOW - (COOLING_THRESHOLD_MS - 1), NOW).status).toBe("HOT");
        expect(computeCacheStatus(NOW - COOLING_THRESHOLD_MS, NOW).status).toBe("COOLING");
        expect(computeCacheStatus(NOW - (CRITICAL_THRESHOLD_MS - 1), NOW).status).toBe("COOLING");
        expect(computeCacheStatus(NOW - CRITICAL_THRESHOLD_MS, NOW).status).toBe("CRITICAL");
        expect(computeCacheStatus(NOW - (CACHE_TTL_MS - 1), NOW).status).toBe("CRITICAL");
        expect(computeCacheStatus(NOW - CACHE_TTL_MS, NOW).status).toBe("COLD");
    });
});

describe("listSessionRows", () => {
    beforeEach(() => {
        listing.sessions = [];
        tails.clear();
        pins.clear();
        cmuxRefs.clear();
    });

    test("filters mtime by hours, includes COLD, and serializes a full SessionRow", async () => {
        const hotPath = "/tmp/hot.jsonl";
        const coldPath = "/tmp/cold.jsonl";
        const oldPath = "/tmp/old.jsonl";

        listing.sessions = [
            record({
                filePath: hotPath,
                sessionId: "hot-id",
                customTitle: "hot title",
                mtime: NOW - 5 * MIN,
                cwd: "/tmp/project",
                project: "GenesisTools",
            }),
            record({
                filePath: coldPath,
                sessionId: "cold-id",
                customTitle: "cold title",
                mtime: NOW - 2 * 60 * MIN,
                cwd: "/tmp/other",
                project: "Other",
            }),
            record({
                filePath: oldPath,
                sessionId: "old-id",
                customTitle: "old title",
                mtime: NOW - 7 * 60 * MIN,
            }),
        ];

        tails.set(hotPath, [SONNET_LINE, OPUS_LINE]);
        tails.set(coldPath, [OPUS_LINE]);
        tails.set(oldPath, [OPUS_LINE]);

        const rows = await listSessionRows({ hours: 6, excludeSubagents: true, now: NOW });
        const ids = rows.map((r) => r.sessionId);

        expect(ids).toEqual(["hot-id", "cold-id"]);
        expect(ids).not.toContain("old-id");

        const hot = rows[0];
        expect(hot?.cacheStatus).toBe("HOT");
        expect(hot?.model).toBe("opus");
        expect(hot?.modelSwitched).toBe(true);
        expect(hot?.filePath).toBe(hotPath);
        expect(hot?.title).toBe("hot title");
        expect(hot?.cwd).toBe("/tmp/project");
        expect(hot?.cwdShort).toBe("/tmp/project");
        expect(hot?.project).toBe("GenesisTools");
        expect(hot?.mtime).toBe(NOW - 5 * MIN);
        expect(hot?.totalTokens).toBe(30);
        expect(hot?.cacheReadTokens).toBe(100);
        expect(hot?.cacheCreateTokens).toBe(5);
        expect(hot?.contextTokens).toBe(115); // input 10 + cacheRead 100 + cacheCreate 5, output excluded
        expect(hot?.compacted).toBe(false);
        expect(hot?.cacheTtlSec).toBeGreaterThan(0);
        expect(Object.keys(hot ?? {}).sort()).toEqual(
            [
                "account",
                "cacheCreateTokens",
                "cacheReadTokens",
                "cacheStatus",
                "cacheTtlSec",
                "cmux",
                "compacted",
                "contextTokens",
                "cwd",
                "cwdShort",
                "filePath",
                "lastCacheAt",
                "lastUserAt",
                "model",
                "modelSwitched",
                "mtime",
                "project",
                "sessionId",
                "title",
                "totalTokens",
            ].sort()
        );

        const cold = rows[1];
        expect(cold?.cacheStatus).toBe("COLD");
        expect(cold?.cacheTtlSec).toBe(0);
        expect(cold?.modelSwitched).toBe(false);
        expect(cold?.filePath).toBe(coldPath);
    });

    test("strips command XML from the row title", async () => {
        const path = "/tmp/cmd.jsonl";
        listing.sessions = [
            record({
                filePath: path,
                sessionId: "cmd-id",
                customTitle:
                    "<command-message><command-name>speckit.implement</command-name></command-message>",
                mtime: NOW - 5 * MIN,
            }),
        ];
        tails.set(path, [OPUS_LINE]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.title).toBe("/speckit.implement");
    });

    test("minRows appends older sessions after the hours window", async () => {
        listing.sessions = [
            record({ filePath: "/tmp/hot.jsonl", sessionId: "hot-id", mtime: NOW - 5 * MIN }),
            record({ filePath: "/tmp/mid.jsonl", sessionId: "mid-id", mtime: NOW - 8 * 60 * MIN }),
            record({ filePath: "/tmp/old.jsonl", sessionId: "old-id", mtime: NOW - 9 * 60 * MIN }),
        ];
        tails.set("/tmp/hot.jsonl", [OPUS_LINE]);
        tails.set("/tmp/mid.jsonl", [OPUS_LINE]);
        tails.set("/tmp/old.jsonl", [OPUS_LINE]);

        const { rows, timings } = await listSessionRowsWithTimings({ hours: 6, minRows: 2, now: NOW });
        expect(rows.map((r) => r.sessionId)).toEqual(["hot-id", "mid-id"]);
        expect(timings.records).toBe(2);
    });

    test("minRows keeps every in-window row when the window already meets N", async () => {
        listing.sessions = [
            record({ filePath: "/tmp/a.jsonl", sessionId: "a", mtime: NOW - 5 * MIN }),
            record({ filePath: "/tmp/b.jsonl", sessionId: "b", mtime: NOW - 2 * 60 * MIN }),
            record({ filePath: "/tmp/c.jsonl", sessionId: "c", mtime: NOW - 5 * 60 * MIN }),
            record({ filePath: "/tmp/old.jsonl", sessionId: "old", mtime: NOW - 8 * 60 * MIN }),
        ];
        tails.set("/tmp/a.jsonl", [OPUS_LINE]);
        tails.set("/tmp/b.jsonl", [OPUS_LINE]);
        tails.set("/tmp/c.jsonl", [OPUS_LINE]);
        tails.set("/tmp/old.jsonl", [OPUS_LINE]);

        const rows = await listSessionRows({ hours: 6, minRows: 2, now: NOW });
        expect(rows.map((r) => r.sessionId).sort()).toEqual(["a", "b", "c"]);
    });

    test("without hours, keeps rows older than 6h", async () => {
        listing.sessions = [record({ filePath: "/tmp/old.jsonl", sessionId: "old-id", mtime: NOW - 7 * 60 * MIN })];
        tails.set("/tmp/old.jsonl", [OPUS_LINE]);

        const rows = await listSessionRows({ excludeSubagents: true, now: NOW });
        expect(rows.map((r) => r.sessionId)).toEqual(["old-id"]);
        expect(rows[0]?.cacheStatus).toBe("COLD");
    });

    test("timings count the filtered records", async () => {
        listing.sessions = [
            record({ filePath: "/tmp/hot.jsonl", sessionId: "hot-id", mtime: NOW - 5 * MIN }),
            record({ filePath: "/tmp/old.jsonl", sessionId: "old-id", mtime: NOW - 7 * 60 * MIN }),
        ];
        tails.set("/tmp/hot.jsonl", [OPUS_LINE]);
        tails.set("/tmp/old.jsonl", [OPUS_LINE]);

        const { rows, timings } = await listSessionRowsWithTimings({ hours: 6, now: NOW });
        expect(rows).toHaveLength(1);
        expect(timings.records).toBe(1);
        expect(timings.totalMs).toBeGreaterThanOrEqual(timings.listingMs);
        expect(timings.tailMs).toBeGreaterThanOrEqual(0);
    });

    // Regression test: tools claude usage Sessions treated inode mtime as prompt-cache TTL.
    // ~/.claude/statusline.sh uses last user|assistant timestamp (not mtime). Session 46768bb6
    // showed HOT from a metadata rewrite while last message was 2026-08-19T12:08:20Z (@14:08:20).
    test("recent mtime with a 3-day-old user/assistant timestamp is COLD", async () => {
        const path = "/tmp/stale-hot.jsonl";
        const threeDays = 3 * 24 * 60 * MIN;
        const ts = new Date(NOW - threeDays).toISOString();

        listing.sessions = [
            record({
                filePath: path,
                sessionId: "stale-hot",
                customTitle: "burn-auth",
                mtime: NOW - 5 * MIN,
            }),
        ];
        tails.set(path, [
            `{"type":"assistant","timestamp":"${ts}","isSidechain":false,"message":{"model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
            `{"type":"user","timestamp":"${ts}","isSidechain":false}`,
            '{"type":"custom-title","customTitle":"burn-auth"}',
        ]);

        const rows = await listSessionRows({ hours: 6, excludeSubagents: true, now: NOW });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.cacheStatus).toBe("COLD");
        expect(rows[0]?.cacheTtlSec).toBe(0);
        expect(rows[0]?.lastCacheAt).toBe(NOW - threeDays);
    });

    test("last user timestamp beats an older assistant, matching statusline", async () => {
        const path = "/tmp/user-wins.jsonl";
        const threeDays = 3 * 24 * 60 * MIN;
        const userTs = new Date(NOW - 5 * MIN).toISOString();
        const asstTs = new Date(NOW - threeDays).toISOString();

        listing.sessions = [record({ filePath: path, sessionId: "user-wins", mtime: NOW })];
        tails.set(path, [
            `{"type":"assistant","timestamp":"${asstTs}","isSidechain":false,"message":{"model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
            `{"type":"user","timestamp":"${userTs}","isSidechain":false}`,
        ]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.cacheStatus).toBe("HOT");
        expect(rows[0]?.lastCacheAt).toBe(NOW - 5 * MIN);
    });

    test("sidechain user timestamps do not keep a stale session HOT", async () => {
        const path = "/tmp/sidechain.jsonl";
        const threeDays = 3 * 24 * 60 * MIN;
        const asstTs = new Date(NOW - threeDays).toISOString();
        const sideTs = new Date(NOW).toISOString();

        listing.sessions = [record({ filePath: path, sessionId: "side", mtime: NOW })];
        tails.set(path, [
            `{"type":"assistant","timestamp":"${asstTs}","isSidechain":false,"message":{"model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
            `{"type":"user","timestamp":"${sideTs}","isSidechain":true}`,
        ]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.cacheStatus).toBe("COLD");
        expect(rows[0]?.lastCacheAt).toBe(NOW - threeDays);
    });

    test("fable-5 is labeled fable, not 5, and HOT sorts above COOLING", async () => {
        listing.sessions = [
            record({
                filePath: "/tmp/cool.jsonl",
                sessionId: "cool-id",
                mtime: NOW - 51 * MIN,
            }),
            record({
                filePath: "/tmp/fable.jsonl",
                sessionId: "fable-id",
                mtime: NOW - 60_000,
            }),
        ];
        tails.set("/tmp/cool.jsonl", [OPUS_LINE]);
        tails.set("/tmp/fable.jsonl", [FABLE_LINE]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows.map((r) => r.sessionId)).toEqual(["fable-id", "cool-id"]);
        expect(rows[0]?.model).toBe("fable");
        expect(rows[0]?.cacheStatus).toBe("HOT");
        expect(rows[1]?.cacheStatus).toBe("COOLING");
    });

    test("a trailing <synthetic> notice does not become the session's model or usage", async () => {
        const path = "/tmp/synthetic.jsonl";
        const synthetic =
            '{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"No response."}]}}';

        listing.sessions = [record({ filePath: path, sessionId: "synth", mtime: NOW - 5 * MIN })];
        tails.set(path, [OPUS_LINE, synthetic]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.model).toBe("opus");
        expect(rows[0]?.modelSwitched).toBe(false);
        expect(rows[0]?.contextTokens).toBe(115);
    });

    test("compact_boundary after the last turn yields the exact postTokens context", async () => {
        const path = "/tmp/compacted.jsonl";
        const boundary =
            '{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"manual","preTokens":427444,"postTokens":27268}}';

        listing.sessions = [record({ filePath: path, sessionId: "compacted", mtime: NOW - 5 * MIN })];
        tails.set(path, [OPUS_LINE, boundary]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.compacted).toBe(true);
        expect(rows[0]?.contextTokens).toBe(27268);
        expect(rows[0]?.model).toBe("opus"); // pre-compact turn still names the model
    });

    test("a compact_boundary older than the last turn changes nothing", async () => {
        const path = "/tmp/old-boundary.jsonl";
        const boundary =
            '{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":9,"postTokens":5}}';

        listing.sessions = [record({ filePath: path, sessionId: "old-boundary", mtime: NOW - 5 * MIN })];
        tails.set(path, [boundary, OPUS_LINE]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.compacted).toBe(false);
        expect(rows[0]?.contextTokens).toBe(115);
    });

    test("lastUserAt takes typed user messages, not tool results or compact summaries", async () => {
        const path = "/tmp/last-user.jsonl";
        const typedTs = new Date(NOW - 30 * MIN).toISOString();
        const toolTs = new Date(NOW - 5 * MIN).toISOString();
        const summaryTs = new Date(NOW - MIN).toISOString();

        listing.sessions = [record({ filePath: path, sessionId: "last-user", mtime: NOW - 5 * MIN })];
        tails.set(path, [
            `{"type":"user","timestamp":"${typedTs}","isSidechain":false,"message":{"role":"user","content":"do the thing"}}`,
            OPUS_LINE,
            `{"type":"user","timestamp":"${toolTs}","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`,
            `{"type":"user","timestamp":"${summaryTs}","isSidechain":false,"isCompactSummary":true,"message":{"role":"user","content":"This session is being continued..."}}`,
        ]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.lastUserAt).toBe(NOW - 30 * MIN);
    });

    test("lastUserAt is found even below two model turns (no early break)", async () => {
        const path = "/tmp/deep-user.jsonl";
        const typedTs = new Date(NOW - 40 * MIN).toISOString();

        listing.sessions = [record({ filePath: path, sessionId: "deep-user", mtime: NOW - 5 * MIN })];
        tails.set(path, [
            `{"type":"user","timestamp":"${typedTs}","isSidechain":false,"message":{"role":"user","content":"start"}}`,
            SONNET_LINE,
            OPUS_LINE,
        ]);

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.lastUserAt).toBe(NOW - 40 * MIN);
        expect(rows[0]?.model).toBe("opus");
        expect(rows[0]?.modelSwitched).toBe(true);
    });

    test("rows carry the pinned account and recorded cmux location", async () => {
        const path = "/tmp/pinned.jsonl";

        listing.sessions = [record({ filePath: path, sessionId: "PINNED-ID", mtime: NOW - 5 * MIN })];
        tails.set(path, [OPUS_LINE]);
        pins.set("PINNED-ID", { account: "uzivatel-a" });
        // Seeded with the journal's OWN casing, not pre-lowercased. The account
        // map lowercases its key and the cmux map did not, so a mixed-case id
        // resolved the account and silently dropped the location.
        cmuxRefs.set("PINNED-ID", { surfaceId: "surface-uuid", at: NOW });

        const rows = await listSessionRows({ hours: 6, now: NOW });
        expect(rows[0]?.account).toBe("uzivatel-a");
        expect(rows[0]?.cmux?.surfaceId).toBe("surface-uuid");
    });

    test("rows with equal clocks keep a deterministic order across polls", async () => {
        const ts = new Date(NOW - 2 * 60 * MIN).toISOString();
        const line = `{"type":"assistant","timestamp":"${ts}","isSidechain":false,"message":{"model":"claude-opus-4-6","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`;

        listing.sessions = [
            record({ filePath: "/tmp/z.jsonl", sessionId: "zzz", mtime: NOW - 5 * MIN }),
            record({ filePath: "/tmp/a.jsonl", sessionId: "aaa", mtime: NOW - 5 * MIN }),
        ];
        tails.set("/tmp/z.jsonl", [line]);
        tails.set("/tmp/a.jsonl", [line]);

        const first = await listSessionRows({ hours: 6, now: NOW });
        listing.sessions.reverse();
        const second = await listSessionRows({ hours: 6, now: NOW });

        expect(first.map((r) => r.sessionId)).toEqual(["aaa", "zzz"]);
        expect(second.map((r) => r.sessionId)).toEqual(["aaa", "zzz"]);
    });
});

test("usage sessions is registered with --json and --hours", () => {
    const program = new Command();
    program.exitOverride();
    registerUsageCommand(program);
    const usage = program.commands.find((c) => c.name() === "usage");
    const sessions = usage?.commands.find((c) => c.name() === "sessions");
    const help = sessions?.helpInformation() ?? "";
    expect(sessions).toBeDefined();
    expect(help).toContain("--json");
    expect(help).toContain("--hours");
    expect(help).toContain("--min");
});
