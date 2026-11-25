import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { diffLines, foldedPatch, fromTop } from "../hooks/sections";
import { MODS_DEFAULTS, modsSettings } from "../hooks/settings";

// Run with `claude plugin test plugins/genesis-tools-mods`; the repo's bun runner skips this folder.

const NOTE = [
    "# Diff of toolu_a",
    "",
    "## /repo/src/a.ts (+2 -1)",
    "",
    "```diff",
    "@@ -1,2 +1,3 @@",
    "-old",
    "+new",
    "+more",
    " same",
    "```",
    "",
    "## /repo/src/b.ts (+1 -0)",
    "",
    "```diff",
    "@@ -1,1 +1,2 @@",
    " keep",
    "+added",
    "```",
].join("\n");

const CALL = {
    tool_use_id: "toolu_a",
    tool: "Bash",
    input: { command: "perl -pi -e s/old/new/ src/a.ts" },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
};

const GROUP = {
    calls: [CALL],
    isActive: false,
    isExpanded: false,
};

/** The engine's own group line, beneath the plugin, and the files the plugin reads. */
function engine(on: On, files: Record<string, string>): void {
    mock.env(on, { HOME: "/home/test" });
    on("fs.read", async (_$, e) => {
        const text = files[e.path];

        if (text === undefined) {
            throw new Error(`no file ${e.path}`);
        }

        return { value: text };
    });
    on("ui.render", { component: "ToolGroup" }, async ($, e) => {
        const { Text } = $.ui.resolve(e);

        return <Text>ran 1 shell command</Text>;
    });
}

const NOTE_PATH = "/home/test/.genesis-tools/agents/hook-diffs/toolu_a.md";

test("each file folds on its own, and the row's Button folds or opens them all", async ($, on) => {
    engine(on, { [NOTE_PATH]: NOTE });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-1",
        viewport: { columns: 160, rows: 40 },
    });
    const A = "group-1|toolu_a|/repo/src/a.ts:fold";
    const B = "group-1|toolu_a|/repo/src/b.ts:fold";

    expect(await ui.find({ text: "ran 1 shell command" })).toBeDefined();
    expect((await ui.find({ key: "group-1:fold" }))?.text).toBe("files only");
    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);
    expect((await ui.find({ key: A }))?.text).toBe("[-]");

    await ui.press({ key: A });

    expect((await ui.find({ key: A }))?.text).toBe("[+]");
    expect((await ui.find({ key: B }))?.text).toBe("[-]");
    expect(await ui.findAll({ type: "Code" })).toHaveLength(1);
    expect((await ui.find({ key: "group-1:fold" }))?.text).toBe("files only");

    await ui.press({ key: "group-1:fold" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    expect((await ui.find({ key: "group-1:fold" }))?.text).toBe("show diff");
    expect(await ui.find({ text: "/repo/src/b.ts" })).toBeDefined();

    await ui.press({ key: "group-1:fold" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);
    await ui.unmount();
});

test("a deleted file starts folded, and its [+] opens it", async ($, on) => {
    const gone = ["## /repo/src/gone.ts (+0 -2)", "", "```diff", "@@ -1,2 +0,0 @@", "-one", "-two", "```"].join("\n");

    engine(on, { [NOTE_PATH]: `${NOTE}\n\n${gone}` });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-2",
    });
    const G = "group-2|toolu_a|/repo/src/gone.ts:fold";

    expect((await ui.find({ key: G }))?.text).toBe("[+]");
    expect(await ui.find({ text: "deleted" })).toBeDefined();
    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);

    await ui.press({ key: G });

    expect((await ui.find({ key: G }))?.text).toBe("[-]");
    expect(await ui.findAll({ type: "Code" })).toHaveLength(3);

    await ui.press({ key: "group-2:fold" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    await ui.unmount();
});

test("an expanded group draws no diffs of its own", async ($, on) => {
    engine(on, { [NOTE_PATH]: NOTE });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: { ...GROUP, isExpanded: true },
    });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    await ui.unmount();
});

test("a git pull's diff starts hidden behind one button, which shows it and hides it again", async ($, on) => {
    engine(on, { [NOTE_PATH]: NOTE });

    const pull = { ...CALL, input: { command: "cd /repo && git pull -q --ff-only 2>&1 | tail -2" } };
    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: { ...GROUP, calls: [pull] },
        requestId: "group-3",
    });

    expect((await ui.find({ key: "group-3|toolu_a:show" }))?.text).toBe("show diff from git pull");
    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    expect(await ui.find({ text: "/repo/src/a.ts" })).toBeUndefined();

    await ui.press({ key: "group-3|toolu_a:show" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);
    expect((await ui.find({ key: "group-3|toolu_a:hide" }))?.text).toBe("hide diff from git pull");

    await ui.press({ key: "group-3|toolu_a:hide" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    await ui.unmount();
});

test("mods.diff.collapseGitSync off (the flat key of before) draws a git pull like any other call", async ($, on) => {
    engine(on, {
        [NOTE_PATH]: NOTE,
        "/home/test/.genesis-tools/agents/hooks.json": '{"mods":{"collapseGitSync":false}}',
    });

    const pull = { ...CALL, input: { command: "git pull" } };
    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: { ...GROUP, calls: [pull] },
        requestId: "group-4",
    });

    expect(await ui.find({ key: "group-4|toolu_a:show" })).toBeUndefined();
    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);
    await ui.unmount();
});

test("under an open diff a second row jumps to the top, and its fold scrolls there before it folds", async ($, on) => {
    engine(on, { [NOTE_PATH]: NOTE });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-5",
        viewport: { columns: 160, rows: 40 },
    });

    expect((await ui.find({ key: "group-5:top" }))?.text).toBe("↑ top");
    expect((await ui.find({ key: "group-5:fold-below" }))?.text).toBe("files only");
    expect((await ui.find({ key: "group-5:everywhere-below" }))?.text).toBe("files only (everywhere)");

    await ui.press({ key: "group-5:top" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);

    await ui.press({ key: "group-5:fold-below" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    expect((await ui.find({ key: "group-5:fold" }))?.text).toBe("show diff");
    // Nothing is open, so there is nothing to jump over: the second row is gone.
    expect(await ui.find({ key: "group-5:top" })).toBeUndefined();
    expect(await ui.find({ key: "group-5:fold-below" })).toBeUndefined();
    await ui.unmount();
});

test("files only (everywhere) folds every block, the drawn one and one drawn later, and opens them again", async ($, on) => {
    engine(on, { [NOTE_PATH]: NOTE });

    const mount = (requestId: string) =>
        $.ui.mount({
            plugin: "genesis-tools-mods",
            surface: "terminal",
            component: "ToolGroup",
            props: GROUP,
            requestId,
            viewport: { columns: 160, rows: 40 },
        });
    const first = await mount("group-6");

    // One file folded by hand before: the everywhere button forgets it.
    await first.press({ key: "group-6|toolu_a|/repo/src/a.ts:fold" });
    expect(await first.findAll({ type: "Code" })).toHaveLength(1);

    await first.press({ key: "group-6:everywhere" });

    expect(await first.findAll({ type: "Code" })).toHaveLength(0);
    expect((await first.find({ key: "group-6:everywhere" }))?.text).toBe("show diff (everywhere)");
    expect((await first.find({ key: "group-6:fold" }))?.text).toBe("show diff");

    // A block drawn after the press starts folded too.
    const later = await mount("group-7");

    expect(await later.findAll({ type: "Code" })).toHaveLength(0);
    expect(await later.find({ text: "/repo/src/b.ts" })).toBeDefined();

    // One file of one block still opens by itself.
    await later.press({ key: "group-7|toolu_a|/repo/src/b.ts:fold" });
    expect(await later.findAll({ type: "Code" })).toHaveLength(1);

    await later.press({ key: "group-7:everywhere" });

    expect(await later.findAll({ type: "Code" })).toHaveLength(2);
    expect(await first.findAll({ type: "Code" })).toHaveLength(2);
    await first.unmount();
    await later.unmount();
});

test("mods.diff.bottomRow off draws no second row, and mods.diff.filesOnly starts every block folded", async ($, on) => {
    engine(on, {
        [NOTE_PATH]: NOTE,
        "/home/test/.genesis-tools/agents/hooks.json": '{"mods":{"diff":{"bottomRow":false,"filesOnly":true}}}',
    });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-8",
    });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    expect((await ui.find({ key: "group-8:everywhere" }))?.text).toBe("show diff (everywhere)");

    await ui.press({ key: "group-8:fold" });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);
    expect(await ui.find({ key: "group-8:top" })).toBeUndefined();
    await ui.unmount();
});

test("a fold from under the block scrolls to the block's top first, and a refused scroll still folds", async () => {
    const order: string[] = [];

    await fromTop(
        async (row) => {
            order.push(`scroll ${row}`);
        },
        "group-9",
        () => order.push("fold")
    );
    await fromTop(
        async () => {
            throw new Error("not person-initiated");
        },
        "group-9",
        () => order.push("fold after a refusal")
    );

    expect(order).toEqual(["scroll group-9", "fold", "fold after a refusal"]);
});

/** A unified-diff hunk of `count` changed lines of a file: each old line removed and its new one added. */
function longHunk(count: number): string[] {
    const removed = Math.ceil(count / 2);
    const added = count - removed;

    return [
        `@@ -1,${removed} +1,${added} @@`,
        ...Array.from({ length: removed }, (_, index) => `-old ${index + 1}`),
        ...Array.from({ length: added }, (_, index) => `+new ${index + 1}`),
    ];
}

/** A diff-hook note with one file of `count` diff lines. */
function longNote(count: number): string {
    const removed = Math.ceil(count / 2);

    return [
        "# Diff of toolu_a",
        "",
        `## /repo/src/long.ts (+${count - removed} -${removed})`,
        "",
        "```diff",
        ...longHunk(count),
        "```",
    ].join("\n");
}

/** A Write over an existing file, as Claude Code stores its result: one hunk of `count` diff lines. */
function writeResult(count: number): Record<string, unknown> {
    const [header = "", ...lines] = longHunk(count);
    const [, oldLines = "0", newLines = "0"] = /^@@ -1,(\d+) \+1,(\d+) @@$/.exec(header) ?? [];

    return {
        type: "update",
        filePath: "/tmp/cc/test/lines.tsv",
        content: "",
        structuredPatch: [{ oldStart: 1, oldLines: Number(oldLines), newStart: 1, newLines: Number(newLines), lines }],
        originalFile: "",
    };
}

/** The engine's own result block under a Write or Edit row, beneath the plugin. */
function resultEngine(on: On, files: Record<string, string>): void {
    engine(on, files);
    on("ui.render", { component: "ToolResult" }, async ($, e) => {
        const { Text } = $.ui.resolve(e);

        return <Text>engine diff</Text>;
    });
}

const RESULT = {
    tool_use_id: "toolu_w",
    tool: "Write",
    output: undefined as unknown,
    isErrored: false,
    isExpanded: false,
};

/** The source of every Code element the drawing holds, in order. */
async function codeSources(ui: {
    findAll: (query: { type: string }) => Promise<{ props: Record<string, unknown> }[]>;
}) {
    return (await ui.findAll({ type: "Code" })).map((code) => String(code.props.source));
}

test("mods.diff.foldAfterLines: 20 by default; 0 and up to 10,000 are kept, anything else falls back to 20", () => {
    const read = (foldAfterLines: unknown) =>
        modsSettings(JSON.stringify({ mods: { diff: { foldAfterLines } } })).diff.foldAfterLines;

    expect(MODS_DEFAULTS.diff.foldAfterLines).toBe(20);
    expect(modsSettings(undefined).diff.foldAfterLines).toBe(20);
    expect(read(0)).toBe(0);
    expect(read(40)).toBe(40);
    expect(read(10_000)).toBe(10_000);
    expect(read(-1)).toBe(20);
    expect(read(10_001)).toBe(20);
    expect(read(2.5)).toBe(20);
    expect(read("30")).toBe(20);
    expect(read(null)).toBe(20);
});

test("a patch past the limit keeps its first lines, and the cut hunk's header counts only what it keeps", () => {
    const patch = ["@@ -1,2 +1,2 @@ fn", " same", "-old", "+new", "@@ -9,1 +9,1 @@", "-a", "+b"].join("\n");

    expect(diffLines(patch)).toBe(5);
    expect(foldedPatch(patch, 5)).toBe(patch);
    expect(foldedPatch(patch, 0)).toBe(patch);
    expect(foldedPatch(patch, 2)).toBe(["@@ -1,2 +1,1 @@ fn", " same", "-old"].join("\n"));
    expect(foldedPatch(patch, 4)).toBe(
        ["@@ -1,2 +1,2 @@ fn", " same", "-old", "+new", "@@ -9,1 +9,0 @@", "-a"].join("\n")
    );
    // `\ No newline at end of file` stays with the line it belongs to and is not counted.
    const tail = ["@@ -1,2 +1,2 @@", "-x", "\\ No newline at end of file", "+y", "+z"].join("\n");
    expect(diffLines(tail)).toBe(3);
    expect(foldedPatch(tail, 1)).toBe(["@@ -1,1 +1,0 @@", "-x", "\\ No newline at end of file"].join("\n"));
});

test("a Write past 20 diff lines draws its first 20 and show all, which opens the engine's diff and folds back", async ($, on) => {
    resultEngine(on, {});

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolResult",
        props: { ...RESULT, output: writeResult(25) },
        requestId: "toolu_w",
    });

    expect(await ui.find({ text: "engine diff" })).toBeUndefined();
    expect((await ui.find({ key: "toolu_w:lines" }))?.text).toBe("show all 25 lines");
    expect(await ui.find({ text: "Added 12 lines, removed 13 lines" })).toBeDefined();
    const [folded = ""] = await codeSources(ui);
    expect(diffLines(folded)).toBe(20);
    expect(folded.startsWith("@@ -1,13 +1,7 @@")).toBe(true);

    await ui.press({ key: "toolu_w:lines" });

    expect(await ui.find({ text: "engine diff" })).toBeDefined();
    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    expect((await ui.find({ key: "toolu_w:lines" }))?.text).toBe("fold to 20 lines");

    await ui.press({ key: "toolu_w:lines" });

    expect(await ui.find({ text: "engine diff" })).toBeUndefined();
    expect((await ui.find({ key: "toolu_w:lines" }))?.text).toBe("show all 25 lines");
    await ui.unmount();
});

test("a Write or Edit of 20 diff lines, a new file and the ctrl+o view draw as the engine does", async ($, on) => {
    resultEngine(on, {});

    const mount = (props: Record<string, unknown>, id: string) =>
        $.ui.mount({
            plugin: "genesis-tools-mods",
            surface: "terminal",
            component: "ToolResult",
            props: { ...RESULT, ...props, tool_use_id: id },
            requestId: id,
        });
    const drawn = [
        await mount({ output: writeResult(20) }, "toolu_1"),
        await mount({ tool: "Edit", output: { ...writeResult(20), type: undefined } }, "toolu_2"),
        await mount({ output: { ...writeResult(25), type: "create" } }, "toolu_3"),
        await mount({ output: writeResult(25), isExpanded: true }, "toolu_4"),
    ];

    for (const [index, ui] of drawn.entries()) {
        expect(await ui.find({ text: "engine diff" })).toBeDefined();
        expect(await ui.find({ key: `toolu_${index + 1}:lines` })).toBeUndefined();
        await ui.unmount();
    }

    // An Edit past the limit folds like a Write.
    const edit = await mount({ tool: "Edit", output: { ...writeResult(30), type: undefined } }, "toolu_5");
    expect((await edit.find({ key: "toolu_5:lines" }))?.text).toBe("show all 30 lines");
    await edit.unmount();
});

test("a Write past the limit into the session's scratchpad folder is left to the engine, which draws it collapsed", async ($, on) => {
    resultEngine(on, {});
    let asked = 0;
    on("session.info", async () => {
        asked += 1;
        return { value: { transcriptPath: "", scratchpadDir: "/tmp/cc/test/" } };
    });

    const inside = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolResult",
        props: { ...RESULT, output: writeResult(25) },
        requestId: "toolu_w",
    });

    expect(asked).toBe(1);
    expect(await inside.find({ text: "engine diff" })).toBeDefined();
    expect(await inside.find({ key: "toolu_w:lines" })).toBeUndefined();
    await inside.unmount();

    // A sibling folder whose name only starts with the scratchpad's is not inside it.
    const beside = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolResult",
        props: { ...RESULT, tool_use_id: "toolu_b", output: { ...writeResult(25), filePath: "/tmp/cc/tester/a.tsv" } },
        requestId: "toolu_b",
    });

    expect((await beside.find({ key: "toolu_b:lines" }))?.text).toBe("show all 25 lines");
    await beside.unmount();
});

test("mods.diff.foldAfterLines 0 never folds a Write, and a shell block's file draws whole", async ($, on) => {
    resultEngine(on, {
        [NOTE_PATH]: longNote(40),
        "/home/test/.genesis-tools/agents/hooks.json": '{"mods":{"diff":{"foldAfterLines":0}}}',
    });

    const result = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolResult",
        props: { ...RESULT, output: writeResult(2_000) },
        requestId: "toolu_w",
    });

    expect(await result.find({ text: "engine diff" })).toBeDefined();
    expect(await result.find({ key: "toolu_w:lines" })).toBeUndefined();
    await result.unmount();

    const block = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-20",
    });

    expect((await codeSources(block)).map(diffLines)).toEqual([40]);
    expect(await block.find({ key: "group-20|toolu_a|/repo/src/long.ts:lines" })).toBeUndefined();
    await block.unmount();
});

test("a shell block's open file past 20 lines draws its first 20 and show all, which opens it and folds it back", async ($, on) => {
    engine(on, { [NOTE_PATH]: longNote(25) });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-21",
        viewport: { columns: 160, rows: 40 },
    });
    const LINES = "group-21|toolu_a|/repo/src/long.ts:lines";

    expect((await codeSources(ui)).map(diffLines)).toEqual([20]);
    expect((await ui.find({ key: LINES }))?.text).toBe("show all 25 lines");

    await ui.press({ key: LINES });

    expect((await codeSources(ui)).map(diffLines)).toEqual([25]);
    expect((await ui.find({ key: LINES }))?.text).toBe("fold to 20 lines");

    await ui.press({ key: LINES });

    expect((await codeSources(ui)).map(diffLines)).toEqual([20]);
    // The file's own [-] still folds it to its name.
    await ui.press({ key: "group-21|toolu_a|/repo/src/long.ts:fold" });
    expect(await ui.findAll({ type: "Code" })).toHaveLength(0);
    expect(await ui.find({ key: LINES })).toBeUndefined();
    await ui.unmount();
});

test("a shell block's file of 20 lines draws whole, with no line button", async ($, on) => {
    engine(on, { [NOTE_PATH]: longNote(20) });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-22",
    });

    expect((await codeSources(ui)).map(diffLines)).toEqual([20]);
    expect(await ui.find({ key: "group-22|toolu_a|/repo/src/long.ts:lines" })).toBeUndefined();
    await ui.unmount();
});

test("a code-mode script's shell call folds and draws like a Bash call, and its row marks the session for the diff hook", async ($, on) => {
    // Claude Code adds a REPL script's calls to the transcript as tool calls of their own (`repl_<uuid>`), so the
    // diff hook may leave their diffs to this mod once a row proved it (col-fe session, 2026-11-25: a fable-replace run
    // inside a REPL script printed the hook's own text diff, because the hook believed such a call had no row).
    const SCRIPT = "/home/test/.genesis-tools/agents/hook-diffs/repl_1b2c3d4e-0000-4000-8000-000000000001.md";
    engine(on, { [SCRIPT]: longNote(25) });
    const marks: { name: string; value?: string }[] = [];
    on("session.id", async () => ({ value: "sess-script" }));
    on("env.set", async (_$, e) => {
        marks.push({ name: e.name, value: e.value });

        return { value: {} };
    });
    const scriptCall = { ...CALL, tool_use_id: "repl_1b2c3d4e-0000-4000-8000-000000000001" };

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: { ...GROUP, calls: [scriptCall] },
        requestId: "group-30",
        viewport: { columns: 160, rows: 40 },
    });
    const LINES = "group-30|repl_1b2c3d4e-0000-4000-8000-000000000001|/repo/src/long.ts:lines";

    expect((await codeSources(ui)).map(diffLines)).toEqual([20]);
    expect((await ui.find({ key: LINES }))?.text).toBe("show all 25 lines");
    // The value is the session's id, which the hook compares with its payload's `session_id`.
    expect(marks).toEqual([{ name: "GENESIS_TOOLS_MODS_SCRIPT_ROWS", value: "sess-script" }]);
    await ui.unmount();
});

test("a Bash tool call's row does not mark the session as one whose script calls draw", async ($, on) => {
    engine(on, { [NOTE_PATH]: NOTE });
    const marks: string[] = [];
    on("session.id", async () => ({ value: "sess-bash" }));
    on("env.set", async (_$, e) => {
        marks.push(e.name);

        return { value: {} };
    });

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: GROUP,
        requestId: "group-31",
    });

    expect(await ui.findAll({ type: "Code" })).toHaveLength(2);
    expect(marks).not.toContain("GENESIS_TOOLS_MODS_SCRIPT_ROWS");
    await ui.unmount();
});
