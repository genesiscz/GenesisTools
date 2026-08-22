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
        expect(hot?.cacheTtlSec).toBeGreaterThan(0);
        expect(Object.keys(hot ?? {}).sort()).toEqual(
            [
                "cacheCreateTokens",
                "cacheReadTokens",
                "cacheStatus",
                "cacheTtlSec",
                "cwd",
                "cwdShort",
                "filePath",
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
});
