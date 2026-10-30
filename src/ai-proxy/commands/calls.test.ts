import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type CallsOptions, collectRecords } from "./calls";

function indexFile(count: number, minutesApart = 1): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-proxy-calls-"));
    const path = join(dir, "requests.jsonl");
    const now = Date.UTC(2026, 6, 25, 12, 0, 0);

    const lines = Array.from({ length: count }, (_, i) =>
        SafeJSON.stringify({
            ts: new Date(now - (count - 1 - i) * minutesApart * 60_000).toISOString(),
            proxyModel: i % 2 === 0 ? "claude-opus-5" : "grok-4.5",
            elapsedMs: i * 1000,
            tags: { session: `run-${i}`, stage: i % 2 === 0 ? "mine" : "filter" },
            // Padding, so a small chunk size splits records across reads.
            note: "x".repeat(200),
        })
    );

    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
}

const base: CallsOptions = { limit: 5 };

describe("collectRecords", () => {
    it("returns [] when the index does not exist", () => {
        expect(collectRecords(base, undefined, join(tmpdir(), "does-not-exist-xyz.jsonl"))).toEqual([]);
    });

    it("returns the newest `limit` records in chronological order", () => {
        const records = collectRecords({ limit: 3 }, undefined, indexFile(20));

        expect(records).toHaveLength(3);
        expect(records.map((r) => r.tags?.session)).toEqual(["run-17", "run-18", "run-19"]);
    });

    it("reads identical records whether or not it has to cross chunk boundaries", () => {
        const path = indexFile(40);
        const oneChunk = collectRecords({ limit: 10 }, undefined, path, 1_000_000);
        const manyChunks = collectRecords({ limit: 10 }, undefined, path, 64);

        expect(manyChunks).toEqual(oneChunk);
        expect(manyChunks).toHaveLength(10);
    });

    it("applies tag and model filters", () => {
        const path = indexFile(20);

        expect(collectRecords({ limit: 50, stage: "filter" }, undefined, path)).toHaveLength(10);
        expect(collectRecords({ limit: 50, model: "opus" }, undefined, path)).toHaveLength(10);
        expect(collectRecords({ limit: 50, session: "run-3" }, undefined, path).map((r) => r.tags?.session)).toEqual([
            "run-3",
        ]);
    });

    it("stops at the cutoff instead of scanning the whole history", () => {
        const path = indexFile(60);
        // Records are one minute apart and end at 2026-07-25T12:00Z; the cutoff itself is kept.
        const cutoff = Date.UTC(2026, 6, 25, 11, 57, 0);
        const records = collectRecords({ limit: 50 }, cutoff, path, 64);

        expect(records.map((r) => r.tags?.session)).toEqual(["run-56", "run-57", "run-58", "run-59"]);
    });

    it("honours slowerThan, boundary included", () => {
        const path = indexFile(20);
        const records = collectRecords({ limit: 50, slowerThan: 17 }, undefined, path);

        expect(records.map((r) => r.elapsedMs)).toEqual([17_000, 18_000, 19_000]);
    });
});

describe("ai-proxy monitor", () => {
    const record = {
        ts: "2026-10-28T00:10:00.000Z",
        account: "work",
        provider: "openai-subscription",
        proxyModel: "codex/gpt-6.1-sol",
        upstreamModel: "gpt-6.1-sol",
        path: "/v1/messages#background-compaction",
        status: 200,
        elapsedMs: 4200,
        stream: true,
        usage: { prompt_tokens: 1000, cache_read_input_tokens: 9000, completion_tokens: 500 },
        tags: { session: "abcdef12-0000" },
        compaction: true,
    };

    it("filters requests by session, compaction, slowness and errors", async () => {
        const { requestPasses } = await import("./monitor");

        expect(requestPasses(record, { session: "abcdef" })).toBe(true);
        expect(requestPasses(record, { session: "zzz" })).toBe(false);
        expect(requestPasses({ ...record, compaction: undefined }, { compaction: true })).toBe(false);
        expect(requestPasses(record, { slow: 5 })).toBe(false);
        expect(requestPasses(record, { errors: true })).toBe(false);
        expect(requestPasses({ ...record, status: 529 }, { errors: true })).toBe(true);
    });

    it("prints a background compaction request and a wasted event with their reason", async () => {
        const { formatEvent, formatRequest, eventPasses } = await import("./monitor");
        const wasted = {
            ts: record.ts,
            kind: "background-wasted" as const,
            claudeSession: "abcdef12-1111",
            reason: "history_changed",
        };

        expect(formatRequest(record)).toContain("BG-COMPACT");
        expect(formatRequest(record)).toContain("hit 90%");
        expect(formatEvent(wasted)).toContain("history_changed");
        expect(eventPasses(wasted, { errors: true, session: "abcdef" })).toBe(true);
        expect(eventPasses({ ...wasted, kind: "done" }, { errors: true })).toBe(false);
    });

    it("names where a missed request's prefix changed, and says nothing on a cached one", async () => {
        // Regression test: Bug 4 of the 8cf9eff2 analysis — a miss row did not say what changed.
        const { formatRequest } = await import("./monitor");
        const missed = {
            ...record,
            usage: { prompt_tokens: 400_000, completion_tokens: 10, cache_read_input_tokens: 0 },
            prefix: { part: "input" as const, index: 2, of: 340, itemType: "reasoning" },
        };
        const upstream = { ...missed, prefix: { part: "none" as const } };

        expect(formatRequest(missed)).toContain("changed input#2/340 reasoning");
        expect(formatRequest(upstream)).toContain("changed nothing (upstream miss)");
        const codexHit = { ...missed, usage: { prompt_tokens: 100, cached_prompt_tokens: 90, completion_tokens: 1 } };
        expect(formatRequest(codexHit)).toContain("hit 90%");
        expect(formatRequest(codexHit)).not.toContain("changed");
        expect(formatRequest({ ...record, prefix: { part: "tools" as const } })).not.toContain("changed");
    });
});
