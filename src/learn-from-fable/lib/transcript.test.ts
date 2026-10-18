import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { FABLE_MODEL } from "./config";
import {
    actionResultLine,
    buildPrefix,
    condenseForExtraction,
    loadTurns,
    referenceGist,
    referenceOutcome,
    TARGET_PROMPT,
    type Turn,
} from "./transcript";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lff-transcript-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(lines: unknown[]): string {
    const path = join(dir, "session.jsonl");
    writeFileSync(path, `${lines.map((line) => SafeJSON.stringify(line, { strict: true })).join("\n")}\n`);
    return path;
}

function assistantLine(
    content: unknown,
    extra: { id?: string; model?: string; uuid?: string; sidechain?: boolean } = {}
): unknown {
    return {
        type: "assistant",
        uuid: extra.uuid,
        isSidechain: extra.sidechain,
        message: { id: extra.id, model: extra.model ?? "other-model-1", content },
    };
}

function userLine(content: unknown, extra: { uuid?: string; meta?: boolean; sidechain?: boolean } = {}): unknown {
    return { type: "user", uuid: extra.uuid, isMeta: extra.meta, isSidechain: extra.sidechain, message: { content } };
}

function resultLine(content: unknown): unknown {
    return userLine([{ type: "tool_result", tool_use_id: "t1", content }]);
}

function turn(overrides: Partial<Turn>): Turn {
    return {
        idx: 0,
        role: "assistant",
        text: "",
        thinking: "",
        tools: [],
        resultGist: "",
        isFable: false,
        isSidechain: false,
        ...overrides,
    };
}

describe("loadTurns", () => {
    test("an assistant turn written as several lines with one message id becomes one turn, even across a tool result", async () => {
        const path = writeJsonl([
            userLine("fix the build"),
            assistantLine([{ type: "thinking", thinking: "look at CI first" }], { id: "m1" }),
            assistantLine([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], { id: "m1" }),
            resultLine("a.ts\nb.ts"),
            assistantLine([{ type: "text", text: "found two files" }], { id: "m1" }),
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => [t.idx, t.role])).toEqual([
            [0, "user"],
            [1, "assistant"],
            [2, "tool_result"],
        ]);
        expect(turns[1]).toMatchObject({
            thinking: "look at CI first",
            text: "found two files",
            tools: [{ name: "Bash", input: { command: "ls" } }],
        });
        expect(turns[2].resultGist).toBe("a.ts\nb.ts");
    });

    test("later text and thinking lines of one message are appended on new lines", async () => {
        const path = writeJsonl([
            assistantLine(
                [
                    { type: "text", text: "first" },
                    { type: "thinking", thinking: "t1" },
                ],
                { id: "m1" }
            ),
            assistantLine(
                [
                    { type: "text", text: "second" },
                    { type: "thinking", thinking: "t2" },
                ],
                { id: "m1" }
            ),
        ]);

        const turns = await loadTurns(path);

        expect(turns).toHaveLength(1);
        expect(turns[0].text).toBe("first\nsecond");
        expect(turns[0].thinking).toBe("t1\nt2");
    });

    test("assistant content that is a plain string, or missing, still becomes a turn", async () => {
        const path = writeJsonl([
            assistantLine("plain reply"),
            assistantLine(undefined),
            { type: "assistant", message: {} },
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => [t.role, t.text, t.thinking, t.tools])).toEqual([
            ["assistant", "plain reply", "", []],
            ["assistant", "", "", []],
            ["assistant", "", "", []],
        ]);
    });

    test("assistant lines without a message id stay separate turns", async () => {
        const path = writeJsonl([
            assistantLine([{ type: "text", text: "one" }]),
            assistantLine([{ type: "text", text: "two" }]),
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => t.text)).toEqual(["one", "two"]);
    });

    test("a turn is fable when its model is the configured fable model, or any merged line's model is", async () => {
        const path = writeJsonl([
            assistantLine([{ type: "text", text: "plain" }], { id: "m1", model: "other-model-1" }),
            assistantLine([{ type: "text", text: "by fable" }], { id: "m2", model: FABLE_MODEL }),
            assistantLine([{ type: "text", text: "starts other" }], { id: "m3", model: "other-model-1" }),
            assistantLine([{ type: "text", text: "then fable" }], { id: "m3", model: FABLE_MODEL }),
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => t.isFable)).toEqual([false, true, true]);
    });

    test("the fable model can be overridden", async () => {
        const path = writeJsonl([assistantLine([{ type: "text", text: "x" }], { id: "m1", model: "custom-model" })]);

        expect((await loadTurns(path))[0].isFable).toBe(false);
        expect((await loadTurns(path, { fableModel: "custom-model" }))[0].isFable).toBe(true);
    });

    test("sidechain lines are flagged on assistant, user and tool result turns", async () => {
        const path = writeJsonl([
            assistantLine([{ type: "text", text: "sub work" }], { id: "m1", sidechain: true }),
            userLine("sub prompt", { sidechain: true }),
            userLine([{ type: "tool_result", tool_use_id: "t1", content: "ok" }], { sidechain: true }),
            userLine("main prompt"),
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => t.isSidechain)).toEqual([true, true, true, false]);
    });

    test("user text keeps images as a marker and drops slash-command scaffolding and empty messages", async () => {
        const path = writeJsonl([
            userLine("  trimmed prompt  "),
            userLine([
                { type: "text", text: "see this" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ]),
            userLine("<local-command-caveat>Caveat: generated by local commands</local-command-caveat>"),
            userLine("<command-name>/model</command-name>"),
            userLine("<command-message>model</command-message>"),
            userLine("<local-command-stdout>Set model</local-command-stdout>"),
            userLine("a meta message", { meta: true }),
            userLine("   "),
            userLine([]),
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => t.text)).toEqual(["trimmed prompt", "see this\n[Image]"]);
    });

    test("user messages with no content or only unknown block types add no turn, and unknown blocks add no text", async () => {
        const path = writeJsonl([
            { type: "user", message: {} },
            userLine(42),
            userLine([{ type: "document", source: { type: "text", data: "attached" } }]),
            userLine([
                { type: "document", source: { type: "text", data: "attached" } },
                { type: "text", text: "read it" },
            ]),
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => t.text)).toEqual(["read it"]);
    });

    test("tool results read string, text-block and object content without printing [object Object]", async () => {
        const path = writeJsonl([
            resultLine("plain output"),
            resultLine([
                { type: "text", text: "first block" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
                { type: "text", text: "second block" },
            ]),
            resultLine({ ok: true, count: 3 }),
            resultLine(null),
        ]);

        const turns = await loadTurns(path);

        expect(turns.map((t) => t.resultGist)).toEqual([
            "plain output",
            "first block\n\nsecond block",
            '{"ok":true,"count":3}',
            "",
        ]);
        expect(turns.every((t) => t.role === "tool_result")).toBe(true);
    });

    test("a long tool result keeps its head, its decisive lines and its tail", async () => {
        const lines = Array.from({ length: 100 }, (_, i) => `noise ${i + 1}`);
        lines[49] = "Error: build failed with exit code 2";
        lines[59] = "all 12 tests passed";
        const path = writeJsonl([resultLine(lines.join("\n"))]);

        const [result] = await loadTurns(path);

        expect(result.resultGist).toBe(
            [
                "noise 1",
                "noise 2",
                "noise 3",
                "noise 4",
                "noise 5",
                "noise 6",
                "…",
                "Error: build failed with exit code 2",
                "all 12 tests passed",
                "noise 99",
                "noise 100",
            ].join("\n")
        );
    });

    test("a very long tool result with no decisive lines is still cut to a bounded gist", async () => {
        const wide = `${"x".repeat(2000)}\nsecond line`;
        const path = writeJsonl([resultLine(wide)]);

        const [result] = await loadTurns(path);

        expect(result.resultGist.length).toBeLessThan(1300);
        expect(result.resultGist).toContain("…[+");
    });

    test("a line repeated under the same uuid is read once unless dedupe is turned off", async () => {
        const duplicated = userLine("resume noise", { uuid: "u-1" });
        const path = writeJsonl([duplicated, duplicated, userLine("other", { uuid: "u-2" })]);

        expect((await loadTurns(path)).map((t) => t.text)).toEqual(["resume noise", "other"]);
        expect((await loadTurns(path, { dedupeUuids: false })).map((t) => t.text)).toEqual([
            "resume noise",
            "resume noise",
            "other",
        ]);
    });

    test("metadata lines, broken JSON and a missing file produce no turns", async () => {
        const path = join(dir, "mixed.jsonl");
        writeFileSync(
            path,
            [
                '{"type":"summary","summary":"x"}',
                '{"type":"system","subtype":"turn_duration"}',
                "not json at all",
                SafeJSON.stringify(userLine("kept"), { strict: true }),
            ].join("\n")
        );

        expect((await loadTurns(path)).map((t) => t.text)).toEqual(["kept"]);
        expect(await loadTurns(join(dir, "does-not-exist.jsonl"))).toEqual([]);
    });
});

describe("actionResultLine", () => {
    test("user and result turns are tagged and cut at 500 characters", () => {
        expect(actionResultLine(turn({ role: "user", text: "do the thing" }))).toBe("[USER] do the thing");
        expect(actionResultLine(turn({ role: "tool_result", resultGist: "exit 0" }))).toBe("[RESULT] exit 0");
        expect(actionResultLine(turn({ role: "user", text: "u".repeat(520) }))).toBe(
            `[USER] ${"u".repeat(500)} …[+20 chars]`
        );
    });

    test("an assistant line lists its tool calls and what it said, and never its thinking", () => {
        const line = actionResultLine(
            turn({
                thinking: "secret reasoning",
                text: "running it",
                tools: [
                    { name: "Bash", input: { command: "ls" } },
                    { name: "Read", input: undefined },
                ],
            })
        );

        expect(line).toBe('[ACTION] Bash({"command":"ls"}); Read()\n[SAYS] running it');
        expect(line).not.toContain("secret reasoning");
    });

    test("a long tool input is cut at 200 characters", () => {
        const line = actionResultLine(turn({ tools: [{ name: "Write", input: { content: "c".repeat(400) } }] }));

        expect(line).toContain("…[+");
        expect(line.length).toBeLessThan(260);
    });

    test("an assistant turn with nothing to show says so", () => {
        expect(actionResultLine(turn({ thinking: "only thoughts" }))).toBe("[ACTION] (none)");
    });
});

describe("referenceGist", () => {
    test("shows thinking, then the action, then the visible text", () => {
        const gist = referenceGist(
            turn({
                thinking: "check the lockfile",
                text: "I will install",
                tools: [{ name: "Bash", input: { command: "bun install" } }],
            })
        );

        expect(gist).toBe(
            'THINKING: check the lockfile\nACTION: Bash({"command":"bun install"})\nSAYS: I will install'
        );
    });

    test("leaves out the parts that are empty, and is empty for an empty turn", () => {
        expect(referenceGist(turn({ text: "just talk" }))).toBe("SAYS: just talk");
        expect(referenceGist(turn({}))).toBe("");
    });

    test("the cap bounds the thinking excerpt", () => {
        const gist = referenceGist(turn({ thinking: "t".repeat(500) }), 100);

        expect(gist).toBe(`THINKING: ${"t".repeat(300)} …[+200 chars]`);
    });
});

describe("condenseForExtraction", () => {
    const turns: Turn[] = [
        turn({ idx: 0, role: "user", text: "ship the release" }),
        turn({
            idx: 1,
            thinking: "tag first",
            text: "tagging",
            tools: [{ name: "Bash", input: { command: "git tag v1" } }],
            isFable: true,
        }),
        turn({ idx: 2, role: "tool_result", resultGist: "created tag" }),
        turn({ idx: 3, text: "done", isFable: false }),
    ];

    test("numbers every turn, shows thinking to the extractor, and labels which model acted", () => {
        const [window] = condenseForExtraction(turns);

        expect(window).toBe(
            [
                "#0 USER\n  ship the release",
                '#1 ASSISTANT (fable)\n  think: tag first\n  do: Bash({"command":"git tag v1"})\n  say: tagging',
                "#2 TOOL_RESULT\n  result: created tag",
                "#3 ASSISTANT (other-model)\n  say: done",
            ].join("\n")
        );
    });

    test("splits into windows at turn boundaries when the character budget is reached", () => {
        const windows = condenseForExtraction(turns, 60);

        expect(windows.length).toBeGreaterThan(1);
        expect(windows.join("\n")).toBe(condenseForExtraction(turns)[0]);
        expect(windows.every((w) => w.startsWith("#"))).toBe(true);
    });

    test("one oversized turn still gets a window of its own", () => {
        const windows = condenseForExtraction(
            [turn({ idx: 0, role: "user", text: "tiny" }), turn({ idx: 1, role: "user", text: "z".repeat(480) })],
            40
        );

        expect(windows).toHaveLength(2);
        expect(windows[0]).toBe("#0 USER\n  tiny");
    });

    test("no turns means no windows", () => {
        expect(condenseForExtraction([])).toEqual([]);
    });
});

describe("buildPrefix", () => {
    const history: Turn[] = [
        turn({ idx: 0, role: "user", text: "task" }),
        turn({ idx: 1, tools: [{ name: "Bash", input: { command: "a" } }], thinking: "never shown" }),
        turn({ idx: 2, role: "tool_result", resultGist: "out-a" }),
        turn({ idx: 3, tools: [{ name: "Bash", input: { command: "b" } }] }),
        turn({ idx: 4, role: "tool_result", resultGist: "out-b" }),
        turn({ idx: 5, role: "user", text: "steer" }),
        turn({ idx: 6, tools: [{ name: "Bash", input: { command: "c" } }] }),
        turn({ idx: 7, role: "tool_result", resultGist: "out-c" }),
        turn({ idx: 8, text: "the move to predict", thinking: "reference thinking" }),
    ];

    test("everything before the chosen turn fits, then the question to the agent follows", () => {
        const prefix = buildPrefix(history, 3);

        expect(prefix).toBe(
            ["[USER] task", '[ACTION] Bash({"command":"a"})', "[RESULT] out-a"].join("\n") + TARGET_PROMPT
        );
        expect(prefix).not.toContain("never shown");
    });

    test("the chosen turn itself is never part of its own prefix", () => {
        const prefix = buildPrefix(history, 8);

        expect(prefix).not.toContain("the move to predict");
        expect(prefix).not.toContain("reference thinking");
        expect(prefix.endsWith(TARGET_PROMPT)).toBe(true);
    });

    test("over budget it keeps every user turn plus the newest trajectory and marks the gap", () => {
        const prefix = buildPrefix(history, 8, 80);

        expect(prefix).toBe(
            ["[USER] task", "…", "[USER] steer", '[ACTION] Bash({"command":"c"})', "[RESULT] out-c"].join("\n") +
                TARGET_PROMPT
        );
    });

    test("over budget it fills from the newest turn backwards and marks a gap inside the kept tail", () => {
        const prefix = buildPrefix(history, 8, 70);

        expect(prefix).toBe(["[USER] task", "…", "[USER] steer", "…", "[RESULT] out-c"].join("\n") + TARGET_PROMPT);
    });

    test("over budget with room for nothing else keeps only the user turns", () => {
        const prefix = buildPrefix(history, 8, 10);

        expect(prefix).toBe(["[USER] task", "…", "[USER] steer"].join("\n") + TARGET_PROMPT);
    });

    test("a prefix for the first turn is just the question", () => {
        expect(buildPrefix(history, 0)).toBe(TARGET_PROMPT);
    });
});

describe("referenceOutcome", () => {
    const turns: Turn[] = [
        turn({ idx: 0, tools: [{ name: "Bash", input: { command: "go" } }] }),
        turn({ idx: 1, role: "tool_result", resultGist: "first result" }),
        turn({ idx: 2, role: "tool_result", resultGist: "" }),
        turn({ idx: 3, role: "user", text: "interjection" }),
        turn({ idx: 4, role: "tool_result", resultGist: "second result" }),
        turn({ idx: 5, text: "next assistant turn" }),
        turn({ idx: 6, role: "tool_result", resultGist: "belongs to a later turn" }),
    ];

    test("joins the results that follow the turn, up to the next assistant turn", () => {
        expect(referenceOutcome(turns, 0)).toBe("first result\nsecond result");
    });

    test("is empty when the next turn is already an assistant turn", () => {
        expect(referenceOutcome(turns, 4)).toBe("");
    });

    test("is cut at the cap", () => {
        expect(referenceOutcome(turns, 0, 8)).toBe("first re");
    });
});
