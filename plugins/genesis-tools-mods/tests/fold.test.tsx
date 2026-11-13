import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { fromTop } from "../hooks/sections";

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
