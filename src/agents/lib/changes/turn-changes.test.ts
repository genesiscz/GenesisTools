import { expect, it } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHUNK_BYTES } from "@genesiscz/utils/agent-sessions/readers/changes-window-cache";
import {
    claudeFixture,
    claudeFixtureNames,
    createFile,
    type Fixture,
    jsonl,
    prompt,
    REPO,
    row,
    use,
} from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/claude-sessions";
import { codexFixture } from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/codex-sessions";
import { logOnlyFixture } from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/log-only";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { releaseMemory } from "@genesiscz/utils/process/release-memory";
import {
    type ChangesRound,
    lastChangedTurns,
    loadRecentSessionChanges,
    loadSessionChanges,
    mergeTurnFiles,
} from "@genesiscz/utils/session-changes";
import { toolDataDir } from "@genesiscz/utils/storage/root";
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
                    expect(rounds.some((r) => r.fallback?.startsWith("F3"))).toBe(false);
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

it("bounds chained writer covers logarithmically across 64 changed turns", async () => {
    const f = claudeFixture("basic");
    if (!f.transcript) {
        throw new Error("missing fixture");
    }
    const turns = 64;
    const lines = Array.from({ length: turns }, (_, i) => [
        prompt(`turn-${i}`, "", 10 * i),
        use(`run-${i}`, "Bash", { command: `bash script-${i - 1}.sh` }, 10 * i + 1),
        ...createFile(`turn-${i}`, `write-${i}`, `${REPO}/script-${i}.sh`, 10 * i + 2, "pwd"),
    ]);
    writeFileSync(f.transcript, `${jsonl([{ padding: "x".repeat(CHUNK_BYTES) }, ...lines.flat()])}\n`);
    await inFixture(f, async () => {
        const input = { sessionId: f.session, log: [], count: 1, initialTurns: 1 };
        const rounds: ChangesRound[] = [];
        const recent = loadRecentSessionChanges({ ...input, onRound: (round) => rounds.push(round) });
        expect(rounds.length).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(turns)));
        expect(fullAnswer(f, 1, recent)).toBe(fullAnswer(f, 1, loadSessionChanges(input)));
    });
});

it("reuses the last answer until its log, transcript or checkpoint changes", async () => {
    const f = claudeFixture("backups");
    const path = f.transcript;
    if (!path) {
        throw new Error("missing Claude fixture");
    }
    appendFileSync(path, `${SafeJSON.stringify({ padding: "x".repeat(CHUNK_BYTES) })}\n`);
    await inFixture(f, async () => {
        const input = { sessionId: f.session, log: f.rows, count: 2, initialTurns: 2 };
        const rounds: ChangesRound[] = [];
        const read = () => loadRecentSessionChanges({ ...input, onRound: (r) => rounds.push(r) });
        const cold = read();
        const expected = fullAnswer(f, 2, cold);
        cold.turns.length = 0;
        rounds.length = 0;
        expect(fullAnswer(f, 2, read())).toBe(expected);
        expect(rounds).toHaveLength(0);
        writeFileSync(join(f.home, "file-history", f.session, "seed"), "old changed");
        expect(fullAnswer(f, 2, read())).toBe(fullAnswer(f, 2, loadSessionChanges(input)));
        expect(rounds.length).toBeGreaterThan(0);
        rounds.length = 0;
        f.rows.push(row(f, "log-only", `${REPO}/added`, 99));
        expect(fullAnswer(f, 2, read())).toBe(fullAnswer(f, 2, loadSessionChanges(input)));
        expect(rounds.length).toBeGreaterThan(0);
        rounds.length = 0;
        appendFileSync(path, `${jsonl([prompt("p9", "", 100), ...createFile("p9", "new", `${REPO}/new`, 101)])}\n`);
        expect(fullAnswer(f, 2, read())).toBe(fullAnswer(f, 2, loadSessionChanges(input)));
        expect(rounds.length).toBeGreaterThan(0);
    });
});

it("keeps an old named log-only row out of the window and preserves a true orphan", async () => {
    const f = claudeFixture("rows");
    if (!f.transcript) {
        throw new Error("missing Claude fixture");
    }
    f.rows.push(row(f, "named", `${REPO}/old`, 92, "named"));
    appendFileSync(f.transcript, `${SafeJSON.stringify({ padding: "x".repeat(CHUNK_BYTES) })}\n`);
    await inFixture(f, async () => {
        const input = { sessionId: f.session, log: f.rows, count: 1, initialTurns: 1 };
        const rounds: ChangesRound[] = [];
        const recent = loadRecentSessionChanges({ ...input, onRound: (round) => rounds.push(round) });
        expect(rounds).toHaveLength(1);
        expect(rounds[0].rows).toBe(0);
        expect(lastChangedTurns(recent, 1)[0].turnId).toBe("unmatched");
        expect(fullAnswer(f, 1, recent)).toBe(fullAnswer(f, 1, loadSessionChanges(input)));
    });
});

it("reopens v1 facts, resumes an append and rebuilds a wrong prefix or version", async () => {
    const f = claudeFixture("basic");
    const path = f.transcript;
    if (!path) {
        throw new Error("missing Claude fixture");
    }
    appendFileSync(path, `${SafeJSON.stringify({ padding: "x".repeat(CHUNK_BYTES) })}\n`);
    await inFixture(f, async () => {
        const input = { sessionId: f.session, log: f.rows, count: 1, initialTurns: 1 };
        const disk = toolDataDir("agents", "changes-facts", "claude", `${f.session}.json`);
        const read = () => {
            releaseMemory();
            expect(fullAnswer(f, 1, loadRecentSessionChanges(input))).toBe(fullAnswer(f, 1, loadSessionChanges(input)));
        };
        const saved = () => SafeJSON.parse(readFileSync(disk, "utf8"), { strict: true });
        read();
        expect(saved().version).toBe(1);
        const prefix = saved().files[path].mark;
        read();
        expect(saved().files[path].mark).toBe(prefix);
        appendFileSync(path, `${jsonl([prompt("p9", "", 90), ...createFile("p9", "new", `${REPO}/new`, 91)])}\n`);
        read();
        const after = saved();
        expect(after.files[path].mark).not.toBe(prefix);
        expect(after.files[path].facts.ledger.at(-1).id).toBe("p9");
        const correct = saved();
        after.files[path].mark = prefix;
        after.files[path].facts.ledger = [];
        writeFileSync(disk, SafeJSON.stringify(after, { strict: true }));
        read();
        expect(saved()).toEqual(correct);
        after.version = 2;
        writeFileSync(disk, SafeJSON.stringify(after, { strict: true }));
        read();
        expect(saved()).toEqual(correct);
    });
});

it("uses the full reader when a foreign turn needs a launcher outside the cut", async () => {
    const f = claudeFixture("subagents");
    const path = f.transcript;
    if (!path) {
        throw new Error("missing fixture");
    }
    const meta = join(dirname(path), f.session, "subagents", "agent-d.meta.json");
    writeFileSync(meta, SafeJSON.stringify({ toolUseId: "launch" }));
    appendFileSync(path, `${SafeJSON.stringify({ padding: "x".repeat(CHUNK_BYTES) })}\n`);
    await inFixture(f, async () => {
        const input = { sessionId: f.session, log: f.rows, count: 1, initialTurns: 1 };
        const rounds: ChangesRound[] = [];
        const recent = loadRecentSessionChanges({ ...input, onRound: (r) => rounds.push(r) });
        expect(rounds.at(-1)?.fallback?.startsWith("F3")).toBe(true);
        expect(fullAnswer(f, 1, recent)).toBe(fullAnswer(f, 1, loadSessionChanges(input)));
    });
});
