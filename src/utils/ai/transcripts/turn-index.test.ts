import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { transcriptEnvelope } from "./load";
import type { ResolvedTranscript } from "./resolve";
import { searchTranscript } from "./search";
import { indexedClaudeEnvelope, turnIndexFor } from "./turn-index";

let serial = 0;
const USER_LINE = '{"type":"user","uuid":"u';

/** The same file with one prompt line turned into a non-turn line of the same length. */
function breakPrompt(text: string, at: number): string {
    return `${text.slice(0, at)}{"type":"xser"${text.slice(at + '{"type":"user"'.length)}`;
}

/** Whole seconds, so a pinned mtime reads back exactly; a coarse clock could give two quick writes one mtime. */
const PINNED_MTIME = 1_700_000_000;

/** Rewrites `file` in place with the prompt of round `round` broken, and sets its mtime to `mtime` seconds. */
function rewriteRound(file: string, round: number, mtime: number): void {
    const text = readFileSync(file, "utf8");
    writeFileSync(file, breakPrompt(text, text.lastIndexOf(USER_LINE, text.indexOf(`prompt ${round} `))));
    utimesSync(file, mtime, mtime);
}
const at = () => new Date(1_700_000_000_000 + serial * 1000).toISOString();
const line = (value: unknown) => `${SafeJSON.stringify(value, { strict: true })}\n`;

function user(text: string): string {
    serial += 1;
    return line({ type: "user", uuid: `u${serial}`, timestamp: at(), message: { role: "user", content: text } });
}

function assistant(text: string, toolId?: string): string {
    serial += 1;
    const content: unknown[] = [{ type: "text", text }];
    if (toolId) {
        content.push({ type: "tool_use", id: toolId, name: "Bash", input: { command: `echo ${toolId}` } });
    }
    return line({ type: "assistant", uuid: `a${serial}`, timestamp: at(), message: { role: "assistant", content } });
}

function toolResult(toolId: string, output: string): string {
    serial += 1;
    return line({
        type: "user",
        uuid: `r${serial}`,
        timestamp: at(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: output }] },
    });
}

function meta(text: string): string {
    serial += 1;
    return line({
        type: "user",
        uuid: `m${serial}`,
        isMeta: true,
        timestamp: at(),
        message: { role: "user", content: text },
    });
}

/** A conversation of `rounds` exchanges: prompt, answer with a tool, its result, and a meta line. */
function conversation(rounds: number, prefix = ""): string {
    let text = "";
    for (let i = 0; i < rounds; i++) {
        const tool = `${prefix}t${i}`;
        text += user(`${prefix}prompt ${i} — žluťoučký kůň 🐴`);
        text += assistant(`${prefix}answer ${i}`, tool);
        text += toolResult(tool, `${prefix}out ${i} ✓`);
        text += meta(`${prefix}caveat ${i}`);
    }
    return text;
}

function setup(content: string): { resolved: ResolvedTranscript; dir: string; file: string } {
    const root = mkdtempSync(join(tmpdir(), "gt-turn-index-"));
    const file = join(root, "session.jsonl");
    writeFileSync(file, content);
    return {
        resolved: { provider: "claude", source: "native", sessionId: "session", filePath: file },
        dir: join(root, "index"),
        file,
    };
}

const slices = [{}, { limit: 3 }, { offset: 0, limit: 2 }, { offset: 5, limit: 4 }, { offset: 999, limit: 5 }];

async function expectSameAsFullParse(resolved: ResolvedTranscript, dir: string): Promise<void> {
    for (const slice of slices) {
        const indexed = indexedClaudeEnvelope(resolved, slice, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, slice);
        expect(indexed).not.toBeNull();
        expect(indexed).toEqual(full);
    }
}

describe("indexedClaudeEnvelope", () => {
    test("returns the same envelope as the full parse for every slice", async () => {
        const { resolved, dir } = setup(conversation(6));
        await expectSameAsFullParse(resolved, dir);
    });

    test("a page before the tail reads its turns and their result reach, not the rest of the file", async () => {
        // 80 turns: `{ offset: 0, limit: 2 }` and `{ offset: 5, limit: 4 }` stop well before the end.
        const { resolved, dir, file } = setup(conversation(40));
        utimesSync(file, PINNED_MTIME, PINNED_MTIME);
        await expectSameAsFullParse(resolved, dir);
        const first = indexedClaudeEnvelope(resolved, { offset: 0, limit: 2 }, { minBytes: 0, dir });

        // Break the prompt of turn 40 in place with the old mtime restored: same size, same inode,
        // same head and tail, so nothing tells the index, and only a read that reaches the line notices.
        rewriteRound(file, 20, PINNED_MTIME);

        expect(indexedClaudeEnvelope(resolved, { offset: 0, limit: 2 }, { minBytes: 0, dir })).toEqual(first);
        // Negative control: the tail page reads the broken line, and the turn count check refuses it.
        expect(indexedClaudeEnvelope(resolved, {}, { minBytes: 0, dir })).toBeNull();
    });

    test("extends the index for appended lines instead of rebuilding it", async () => {
        const { resolved, dir, file } = setup(conversation(4));
        const first = turnIndexFor(file, { minBytes: 0, dir });
        const offsets = [...(first?.turnOffsets ?? [])];

        appendFileSync(file, conversation(3, "late "));
        const grown = turnIndexFor(file, { minBytes: 0, dir });
        expect(grown?.turnOffsets.slice(0, offsets.length)).toEqual(offsets);
        expect(grown?.turnOffsets.length).toBe(offsets.length + 6);
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds when the file was rewritten under the same name", async () => {
        const { resolved, dir, file } = setup(conversation(5));
        turnIndexFor(file, { minBytes: 0, dir });
        writeFileSync(file, conversation(2, "other "));
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds after a rewrite in place that keeps the head and the size", async () => {
        const { resolved, dir, file } = setup(conversation(15));
        const turns = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

        // The last prompt stops being a turn: one turn fewer, same size, same first 4 KiB.
        const text = readFileSync(file, "utf8");
        writeFileSync(file, breakPrompt(text, text.lastIndexOf(USER_LINE)));

        expect(turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length).toBe((turns ?? 0) - 1);
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds after a same-size rewrite between the head and the tail it checks", async () => {
        const { resolved, dir, file } = setup(conversation(40));
        utimesSync(file, PINNED_MTIME, PINNED_MTIME);
        const turns = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

        // Turn 40 of 80 sits far from both hashed windows: only the later mtime says the file was rewritten.
        rewriteRound(file, 20, PINNED_MTIME + 1);

        expect(turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length).toBe((turns ?? 0) - 1);
        await expectSameAsFullParse(resolved, dir);
    });

    test("rebuilds after a rewrite inside a hashed window that keeps size, mtime and inode", async () => {
        // Round 0 is in the first 4 KiB, round 14 in the last 4 KiB before the indexed end.
        for (const round of [0, 14]) {
            const { resolved, dir, file } = setup(conversation(15));
            utimesSync(file, PINNED_MTIME, PINNED_MTIME);
            const turns = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

            // The old mtime restored: the stamp says nothing changed, only the hashes can tell.
            rewriteRound(file, round, PINNED_MTIME);

            expect({ round, turns: turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length }).toEqual({
                round,
                turns: (turns ?? 0) - 1,
            });
            await expectSameAsFullParse(resolved, dir);
        }
    });

    test("skips a half-written last line until it is complete", async () => {
        const { resolved, dir, file } = setup(conversation(3));
        const whole = assistant("finished later", "tz");
        appendFileSync(file, whole.slice(0, 25));
        await expectSameAsFullParse(resolved, dir);
        const before = turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length;

        writeFileSync(file, readFileSync(file, "utf8") + whole.slice(25));
        expect(turnIndexFor(file, { minBytes: 0, dir })?.turnOffsets.length).toBe((before ?? 0) + 1);
        await expectSameAsFullParse(resolved, dir);
    });

    test("leaves small files, other providers and worker files to the full parse", () => {
        const { resolved, dir } = setup(conversation(2));
        expect(indexedClaudeEnvelope(resolved, {}, { dir })).toBeNull();
        expect(indexedClaudeEnvelope({ ...resolved, provider: "codex" }, {}, { minBytes: 0, dir })).toBeNull();
        expect(indexedClaudeEnvelope({ ...resolved, source: "worker" }, {}, { minBytes: 0, dir })).toBeNull();
    });
});

describe("searchTranscript", () => {
    const content = () =>
        conversation(3) +
        user("the Timestamp of the deploy") +
        assistant("done", "tq") +
        toolResult("tq", "MARKER line");

    async function bothPaths(resolved: ResolvedTranscript, dir: string, query: string) {
        const indexed = await searchTranscript(resolved, { query }, { minBytes: 0, dir });
        const full = await searchTranscript(resolved, { query }, { minBytes: Number.POSITIVE_INFINITY, dir });
        expect(indexed).toEqual(full);
        return indexed;
    }

    test("matches text, tool input and tool result, case-insensitively, on the right turn", async () => {
        const { resolved, dir } = setup(content());
        // Turns: prompt 0, answer 0, prompt 1, answer 1, prompt 2, answer 2, the Timestamp prompt, done.
        expect((await bothPaths(resolved, dir, "ANSWER 1")).turns).toEqual([3]);
        expect((await bothPaths(resolved, dir, "echo t2")).turns).toEqual([5]);
        expect((await bothPaths(resolved, dir, "out 0 ✓")).turns).toEqual([1]);
        expect((await bothPaths(resolved, dir, "marker")).turns).toEqual([7]);
        expect((await bothPaths(resolved, dir, "ŽLUŤOUČKÝ")).turns).toEqual([0, 2, 4]);
    });

    test("ignores a hit on a JSON key but finds the same word in visible text", async () => {
        const { resolved, dir } = setup(content());
        expect(await bothPaths(resolved, dir, "tool_use_id")).toEqual({
            sessionId: "session",
            total: 0,
            turns: [],
            truncated: false,
        });
        expect((await bothPaths(resolved, dir, "timestamp")).turns).toEqual([6]);
    });

    test("caps the returned turns at limit and still counts every match", async () => {
        const { resolved, dir } = setup(content());
        const result = await searchTranscript(resolved, { query: "prompt", limit: 2 }, { minBytes: 0, dir });
        expect(result).toEqual({ sessionId: "session", total: 3, turns: [0, 2], truncated: true });
    });

    test("finds a tool result that lands after a later prompt", async () => {
        const late =
            user("start") + assistant("working", "tl") + user("are you done?") + toolResult("tl", "late RESULT");
        const { resolved, dir } = setup(late);
        expect((await bothPaths(resolved, dir, "late result")).turns).toEqual([1]);
        const sparse = indexedClaudeEnvelope(resolved, { turns: [1] }, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, { turns: [1] });
        expect(sparse).toEqual(full);
        expect(sparse?.turns[0]?.tools[0]?.result).toBe("late RESULT");
    });
});

describe("sparse envelopes", () => {
    test("returns exactly the requested turns with their global index, on both paths", async () => {
        const { resolved, dir } = setup(conversation(6));
        const turns = [9, 2, 2, 400, -1, 7];
        const indexed = indexedClaudeEnvelope(resolved, { turns }, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, { turns });
        expect(indexed).toEqual(full);
        expect(full.turns.map((turn) => turn.index)).toEqual([2, 7, 9]);
        expect(full.turns.map((turn) => turn.text)).toEqual(["prompt 1 — žluťoučký kůň 🐴", "answer 3", "answer 4"]);
        expect(full.nextOffset).toBe(10);
        expect(full.truncated).toBe(true);
    });

    test("a default slice carries no index", async () => {
        const { resolved, dir } = setup(conversation(2));
        const indexed = indexedClaudeEnvelope(resolved, {}, { minBytes: 0, dir });
        const full = await transcriptEnvelope(resolved, {});
        expect(full.turns.some((turn) => "index" in turn)).toBe(false);
        expect(indexed?.turns.some((turn) => "index" in turn)).toBe(false);
    });
});
