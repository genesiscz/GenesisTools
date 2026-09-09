import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { generateHistoryCorpus } from "./corpus";
import { createFixtureWorld } from "./fixture-world";

describe("generated history corpus", () => {
    test("reproduces source bytes from an explicit seed and distribution", async () => {
        const firstWorld = await createFixtureWorld();
        const secondWorld = await createFixtureWorld();
        const thirdWorld = await createFixtureWorld();
        try {
            const options = {
                seed: 73,
                sessionCount: 4,
                recordCount: 12,
                distribution: { main: 3, subagent: 1 },
            } as const;
            const first = await generateHistoryCorpus({ root: firstWorld.root, ...options });
            const second = await generateHistoryCorpus({ root: secondWorld.root, ...options });
            const third = await generateHistoryCorpus({ root: thirdWorld.root, ...options, seed: 74 });

            expect(first).toEqual(second);
            expect(third.sources.map((source) => source.sha256)).not.toEqual(
                first.sources.map((source) => source.sha256)
            );
            expect(first.logical).toEqual({ sessions: 4, records: 12, main: 3, subagent: 1 });
            expect(first.providers).toEqual({ claude: 4, codex: 4, grok: 4 });
            expect(first.queries).toEqual({
                common: "benchmark-common-term",
                rare: "benchmark-rare-73",
                absent: "benchmark-absent-term",
            });
            const claudeContents = await Promise.all(
                first.sources
                    .filter((source) => source.provider === "claude")
                    .map((source) => Bun.file(`${firstWorld.root}/${source.relativePath}`).text())
            );
            expect(claudeContents.filter((content) => content.includes(first.queries.common))).toHaveLength(4);
            expect(claudeContents.filter((content) => content.includes(first.queries.rare))).toHaveLength(1);
            expect(claudeContents.some((content) => content.includes(first.queries.absent))).toBe(false);
            expect(first.sessions).toHaveLength(4);
            expect(first.sessions[3]?.isSubagent).toBe(true);
            expect(first.sessions.every((session) => /^[0-9a-f-]{36}$/.test(session.sessionId))).toBe(true);
            expect(first.sources.length).toBeGreaterThan(12);
            expect(first.totalBytes).toBeGreaterThan(0);
            expect(first.sources.every((source) => existsSync(`${firstWorld.root}/${source.relativePath}`))).toBe(true);
            expect(first.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256))).toBe(true);
        } finally {
            await Promise.all([firstWorld.dispose(), secondWorld.dispose(), thirdWorld.dispose()]);
        }
    });
});
