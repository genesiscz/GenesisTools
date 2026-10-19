import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

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

const GROUP = {
    calls: [
        {
            tool_use_id: "toolu_a",
            tool: "Bash",
            input: { command: "perl -pi -e s/old/new/ src/a.ts" },
            isRunning: false,
            isErrored: false,
            isInterrupted: false,
        },
    ],
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
