import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { FableConfig } from "../config";
import { persistScores } from "./filter";
import type { Episode } from "./types";

function episode(id: string, scores?: { referenceScore: number; naiveScore: number }): Episode {
    return {
        id,
        sourceSession: "/tmp/session.jsonl",
        taskType: "verification",
        contextPrefix: "prefix",
        referenceAction: "action",
        referenceOutcome: "outcome",
        specAxes: [],
        minedBy: "ai-proxy:martin/grok/grok-4.5",
        runId: "run-1",
        ...scores,
    };
}

function packWithRaw(episodes: Episode[]): { config: FableConfig; rawPath: string } {
    const pack = mkdtempSync(join(tmpdir(), "lff-filter-"));
    const dir = join(pack, "meta", "episodes");
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, "episodes.slug.raw.jsonl");
    writeFileSync(rawPath, `${episodes.map((e) => SafeJSON.stringify(e, { strict: true })).join("\n")}\n`);
    return { config: { packPath: pack } as FableConfig, rawPath };
}

function readRaw(path: string): Episode[] {
    return readFileSync(path, "utf-8")
        .trim()
        .split("\n")
        .map((l) => SafeJSON.parse(l, { strict: true }) as Episode);
}

describe("persistScores", () => {
    test("writes scores back onto dropped episodes, not only the kept ones", () => {
        // The whole point: a run that judged 446 and kept 148 left 292 looking
        // unassessed, so every re-run paid to judge them again.
        const { config, rawPath } = packWithRaw([episode("a"), episode("b"), episode("c")]);

        const updated = persistScores(config, "slug", [
            { ...episode("a"), referenceScore: 0.9, naiveScore: 0.2, naiveReply: "meh" },
            // 'b' scored well for the bare model — dropped as no-headroom, still assessed
            { ...episode("b"), referenceScore: 0.95, naiveScore: 0.8, naiveReply: "good" },
        ]);

        expect(updated).toBe(2);
        const rows = readRaw(rawPath);
        expect(rows.find((e) => e.id === "a")?.referenceScore).toBe(0.9);
        expect(rows.find((e) => e.id === "b")?.naiveScore).toBe(0.8);
        expect(rows.find((e) => e.id === "c")?.referenceScore).toBeUndefined();
    });

    test("leaves every untouched episode byte-identical", () => {
        const { config, rawPath } = packWithRaw([episode("a"), episode("b")]);
        const before = readRaw(rawPath).find((e) => e.id === "b");

        persistScores(config, "slug", [{ ...episode("a"), referenceScore: 0.9, naiveScore: 0.1 }]);

        expect(readRaw(rawPath).find((e) => e.id === "b")).toEqual(before);
    });

    test("a missing raw file is a no-op, not a crash", () => {
        const pack = mkdtempSync(join(tmpdir(), "lff-filter-"));
        expect(persistScores({ packPath: pack } as FableConfig, "absent", [episode("a")])).toBe(0);
    });
});
