import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBlameCommand } from "@app/agents/commands/blame";
import { Command } from "commander";
import { addedLines, type BlameDeps, blameFiles, blameText, promptOf, toRanges, turnPrompts } from "./blame";
import type { ChangeEvent } from "./log";

function event(over: Partial<ChangeEvent> & Pick<ChangeEvent, "ts" | "afterOid">): ChangeEvent {
    return {
        provider: "claude",
        session: "s-one",
        turn: "t-1",
        tool: "Edit",
        toolUseId: "toolu_1",
        cwd: "/work/shop",
        path: "/work/shop/src/cart.ts",
        beforeOid: null,
        source: "edit",
        ...over,
    };
}

const blobs: Record<string, string> = {
    v1: "const total = 0;\n}\nexport function add() {\n",
    v2: "const total = 0;\n}\nexport function add() {\n    return total + 1;\n",
    v3: "const total = 10;\n}\nexport function add() {\n    return total + 1;\n",
};

describe("agent line blame", () => {
    test("added lines are counted, so a moved line is not new and a duplicate is", () => {
        expect(addedLines("a\nb\n", "b\na\n")).toEqual([]);
        expect(addedLines("a\n", "a\na\nc")).toEqual(["a", "c"]);
        expect(addedLines(null, "x\ny")).toEqual(["x", "y"]);
    });

    test("each line goes to the last change that added its text; short lines stay unattributed", () => {
        const events = [
            event({ ts: "2026-09-20T10:00:00Z", afterOid: "v2", beforeOid: "v1", turn: "t-2" }),
            event({ ts: "2026-09-19T10:00:00Z", afterOid: "v1", turn: "t-1" }),
            event({ ts: "2026-09-21T10:00:00Z", afterOid: "v3", beforeOid: "v2", session: "s-two", turn: "t-9" }),
        ];
        const perLine = blameText({ current: blobs.v3, events, text: (oid) => blobs[oid] ?? null });
        // line 1 rewritten by s-two, line 2 is "}", line 3 from the first write, line 4 from t-2.
        expect(perLine).toEqual([2, null, 1, 0, null]);
    });

    test("a duplicated line belongs to the change that added that copy, not to every copy of the text", () => {
        const texts: Record<string, string> = {
            one: "const total = 0;\n",
            two: "const total = 0;\nconst total = 0;\n",
            moved: "export const a = 1;\nexport const b = 2;\n",
            swapped: "export const b = 2;\nexport const a = 1;\n",
        };
        const text = (oid: string) => texts[oid] ?? null;
        const duplicate = [
            event({ ts: "2026-09-19T10:00:00Z", afterOid: "one", turn: "t-1" }),
            event({ ts: "2026-09-20T10:00:00Z", afterOid: "two", beforeOid: "one", session: "s-two", turn: "t-2" }),
        ];

        expect(blameText({ current: texts.two, events: duplicate, text })).toEqual([0, 1, null]);

        // A swap adds no text, so the swapping change claims no line.
        const swap = [
            event({ ts: "2026-09-19T10:00:00Z", afterOid: "moved", turn: "t-1" }),
            event({ ts: "2026-09-20T10:00:00Z", afterOid: "swapped", beforeOid: "moved", turn: "t-2" }),
        ];
        expect(blameText({ current: texts.swapped, events: swap, text })).toEqual([0, 0, null]);
    });

    test("a change whose before-state blob is gone is skipped instead of claiming the whole file", () => {
        const events = [event({ ts: "2026-09-20T10:00:00Z", afterOid: "v2", beforeOid: "gone" })];
        expect(blameText({ current: blobs.v2, events, text: (oid) => blobs[oid] ?? null })).toEqual([
            null,
            null,
            null,
            null,
            null,
        ]);
    });

    test("ranges join runs of one owner and skip the rest", () => {
        expect(toRanges([0, 0, null, 1, 1, 0])).toEqual([
            [1, 2, 0],
            [4, 5, 1],
            [6, 6, 0],
        ]);
    });

    test("a transcript row's prompt comes from a string content or its text parts", () => {
        expect(promptOf('{"message":{"content":"fix   the\\ncart"}}')).toBe("fix the cart");
        expect(
            promptOf('{"message":{"content":[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]}}')
        ).toBe("a b");
        expect(promptOf('{"type":"summary"}')).toBeNull();
        // A torn row, or one cut short by the search buffer, has no prompt instead of throwing.
        expect(promptOf('{"message":{"content":"fix the')).toBeNull();
    });

    test("a torn prompt row costs only its own turn, not every later turn of the session", () => {
        const transcript = join(mkdtempSync(join(tmpdir(), "blame-prompts-")), "session.jsonl");
        writeFileSync(
            transcript,
            '{"promptId":"t-1","message":{"content":"cut sho\n{"promptId":"t-2","message":{"content":"second prompt"}}\n'
        );

        expect([...turnPrompts("s-one", ["t-1", "t-2"], () => transcript)]).toEqual([["t-2", "second prompt"]]);
    });

    test("blameFiles counts every checkout, one source per turn, and prompts only for Claude", async () => {
        const deps: BlameDeps = {
            checkouts: async () => ["/work/shop", "/work/shop-wt"],
            events: (paths) => ({
                logs: 2,
                events: [
                    event({
                        ts: "2026-09-19T10:00:00Z",
                        afterOid: "v1",
                        path: "/work/shop-wt/src/cart.ts",
                        turn: "t-1",
                    }),
                    event({ ts: "2026-09-20T10:00:00Z", afterOid: "v2", beforeOid: "v1", turn: "t-2" }),
                    event({
                        ts: "2026-09-21T10:00:00Z",
                        afterOid: "v3",
                        beforeOid: "v2",
                        provider: "codex",
                        session: "s-two",
                        turn: "t-9",
                    }),
                ].filter((row) => paths.has(row.path)),
            }),
            blobs: (oids) => new Map(oids.filter((oid) => blobs[oid]).map((oid) => [oid, Buffer.from(blobs[oid])])),
            read: (path) => (path === "/work/shop/src/cart.ts" ? blobs.v3 : null),
            prompts: async (session, turns) => new Map(turns.map((turn) => [turn, `${session} asked ${turn}`])),
            now: () => new Date("2026-09-24T12:00:00Z"),
        };
        const result = await blameFiles({ repo: "/work/shop", files: ["src/cart.ts", "src/none.ts"] }, deps);
        expect(result.files).toEqual([
            {
                path: "src/cart.ts",
                ranges: [
                    [1, 1, 0],
                    [3, 3, 1],
                    [4, 4, 2],
                ],
            },
        ]);
        expect(result.sources.map((source) => [source.session, source.turn, source.prompt])).toEqual([
            ["s-two", "t-9", null],
            ["s-one", "t-1", "s-one asked t-1"],
            ["s-one", "t-2", "s-one asked t-2"],
        ]);
        expect(result.scanned).toEqual({ logs: 2, events: 3, blobs: 3 });
    });

    test("the CLI takes one argument per path, so a path with a comma or a space reaches blame whole", async () => {
        const asked: string[] = [];
        const deps: BlameDeps = {
            checkouts: async () => [],
            events: () => ({ events: [], logs: 0 }),
            blobs: () => new Map(),
            read: (path) => {
                asked.push(path);
                return null;
            },
            prompts: async () => new Map(),
            now: () => new Date("2026-09-24T12:00:00Z"),
        };
        const program = new Command().exitOverride();
        registerBlameCommand(program, deps);
        await program.parseAsync(["blame", "--repo", "/work/shop", "--files", "src/a,b.ts", "src/c d.ts", "--json"], {
            from: "user",
        });
        expect(asked).toEqual(["/work/shop/src/a,b.ts", "/work/shop/src/c d.ts"]);
    });
});
