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
