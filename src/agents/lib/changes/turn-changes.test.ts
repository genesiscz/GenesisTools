import { expect, it } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHUNK_BYTES } from "@genesiscz/utils/agent-sessions/readers/changes-window-cache";
import {
    claudeFixture,
    claudeFixtureNames,
    createFile,
    type Fixture,
    jsonl,
    prompt,
} from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/claude-sessions";
import { codexFixture } from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/codex-sessions";
import { logOnlyFixture } from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/log-only";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type ChangesRound,
    lastChangedTurns,
    loadRecentSessionChanges,
    loadSessionChanges,
    mergeTurnFiles,
} from "@genesiscz/utils/session-changes";
import { excludedOf, sessionTurnChanges, turnChangesJson } from "./tool-changes";

const fixtures = [
    ...claudeFixtureNames.map((name) => ({ name, build: () => claudeFixture(name) })),
    { name: "codex", build: codexFixture },
    { name: "grok", build: logOnlyFixture },
];

function inFixture(f: Fixture, run: () => Promise<void>) {
    return env.testing.withOverrides(
        { GENESIS_TOOLS_HOME: f.home, CLAUDE_CONFIG_DIR: f.home, CODEX_HOME: f.home },
        run
    );
}

async function answer(f: Fixture, count: number) {
    const result = await sessionTurnChanges({ session: f.session, file: f.log, rows: f.rows, options: {}, count });
    if ("error" in result) {
        throw new Error(result.error);
    }
    return SafeJSON.stringify(turnChangesJson(f.session, f.log, {}, result), { strict: true }).replaceAll(
        f.home,
        "<home>"
    );
}

for (const { name, build } of fixtures) {
    it(`pins the last changed turns of ${name}`, async () => {
        const f = build();
        const path = new URL(
            `../../../utils/agent-sessions/readers/fixtures/changes/golden/${name}.json`,
            import.meta.url
        );
        const expected: Record<string, unknown> = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        await inFixture(f, async () => {
            for (const [count, golden] of Object.entries(expected)) {
                expect(SafeJSON.parse(await answer(f, Number(count)))).toEqual(golden);
            }
        });
    });
}

function fullAnswer(f: Fixture, count: number, changes: ReturnType<typeof loadSessionChanges>) {
    const selected = lastChangedTurns(changes, count);
    const files = mergeTurnFiles(selected);
    const excluded = excludedOf(selected, files);
    return SafeJSON.stringify(
        turnChangesJson(f.session, f.log, {}, { changes, selected, files, excluded, diffs: null }),
        { strict: true }
    );
}

for (const { name, build } of fixtures) {
    it(`matches the full JSON for every count and first round of ${name}`, async () => {
        const f = build();
        if (f.transcript) {
            appendFileSync(f.transcript, `${SafeJSON.stringify({ padding: "x".repeat(CHUNK_BYTES) })}\n`);
        }
        await inFixture(f, async () => {
            const input = { sessionId: f.session, log: f.rows };
            const full = loadSessionChanges(input);
            for (let count = 1; count <= f.turns + 2; count++) {
                for (const initialTurns of [1, undefined]) {
                    const rounds: ChangesRound[] = [];
                    const recent = loadRecentSessionChanges({
                        ...input,
                        count,
                        initialTurns,
                        onRound: (r) => rounds.push(r),
                    });
                    expect(rounds.some((r) => r.fallback === "F3")).toBe(false);
                    if (name !== "grok" && count > lastChangedTurns(full, f.turns + 2).length) {
                        expect(rounds.at(-1)?.fallback).toBe("F1");
                    }
                    expect(fullAnswer(f, count, recent)).toBe(fullAnswer(f, count, full));
                }
            }
        });
    });
}

for (const name of ["basic", "subagents"] as const) {
    it(`advances a warm ${name} window after the transcript grows`, async () => {
        const f = claudeFixture(name);
        const path = f.transcript;
        if (!path) {
            throw new Error("missing fixture");
        }
        appendFileSync(path, `${SafeJSON.stringify({ padding: "x".repeat(CHUNK_BYTES) })}\n`);
        await inFixture(f, async () => {
            const input = { sessionId: f.session, log: f.rows, count: 1, initialTurns: 1 };
            loadRecentSessionChanges(input);
            const lines = [prompt("p9", "append", 90), ...createFile("p9", "new", "/work/acme/new", 91)];
            appendFileSync(path, `${jsonl(lines)}\n`);
            if (name === "subagents") {
                const agent = join(dirname(path), f.session, "subagents", "agent-a.jsonl");
                appendFileSync(
                    agent,
                    `${jsonl([prompt("p9", "", 93), ...createFile("p9", "grown", "/work/acme/grown", 94)])}\n`
                );
            }
            const count = name === "subagents" ? 2 : 1;
            const recent = loadRecentSessionChanges({ ...input, count });
            expect(fullAnswer(f, count, recent)).toBe(fullAnswer(f, count, loadSessionChanges(input)));
        });
    });
}

it.each([
    ["rows", 3, "late"],
    ["rows", 5, "rows"],
    ["heredoc", 2, "writers"],
] as const)("expands %s from %i turns for %s", async (name, initialTurns, trigger) => {
    const f = claudeFixture(name);
    if (!f.transcript) {
        throw new Error("missing fixture");
    }
    appendFileSync(f.transcript, `${SafeJSON.stringify({ padding: "x".repeat(CHUNK_BYTES) })}\n`);
    await inFixture(f, async () => {
        const rounds: ChangesRound[] = [];
        const result = loadRecentSessionChanges({
            sessionId: f.session,
            log: f.rows,
            count: 1,
            initialTurns,
            onRound: (round) => rounds.push(round),
        });
        expect(rounds.some((round) => round[trigger] > 0)).toBe(true);
        expect(fullAnswer(f, 1, result)).toBe(
            fullAnswer(f, 1, loadSessionChanges({ sessionId: f.session, log: f.rows }))
        );
    });
});
