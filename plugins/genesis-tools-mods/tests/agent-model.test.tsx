import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

// Run with `claude plugin test plugins/genesis-tools-mods`, with the fold tests.

const SONNET = {
    status: "async_launched",
    agentId: "agent-1",
    description: "Audit pultik installer writes",
    resolvedModel: "claude-sonnet-5-5",
    modelsUsed: ["claude-sonnet-5-5"],
    prompt: "audit",
    outputFile: "/tmp/out",
};

const HAIKU = { ...SONNET, agentId: "agent-2", resolvedModel: "claude-haiku-5-5", modelsUsed: ["claude-haiku-5-5"] };

const AGENT = {
    tool_use_id: "toolu_a",
    tool: "Agent",
    input: { description: "Audit pultik installer writes", prompt: "audit" },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: SONNET,
};

const SHELL = {
    tool_use_id: "toolu_b",
    tool: "Bash",
    input: { command: "git status" },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: { stdout: "", stderr: "" },
};

/** The engine's own rows, beneath the plugin's. The full-diff hook reads the hooks file under HOME. */
function engine(on: On): void {
    mock.env(on, { HOME: "/home/test" });
    on("ui.render", { component: "ToolUse" }, async ($, e) => {
        const { Text } = $.ui.resolve(e);

        return <Text>{e.props.tool} row</Text>;
    });
    on("ui.render", { component: "ToolGroup" }, async ($, e) => {
        const { Text } = $.ui.resolve(e);

        return <Text>{e.props.calls.length} calls</Text>;
    });
}

test("an Agent row names the model it resolved to", async ($, on) => {
    engine(on);

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolUse",
        props: AGENT,
    });

    expect(await ui.findAll({ type: "Text", text: /sonnet-5-5/ })).toHaveLength(1);
    await ui.unmount();
});

test("a running Agent row says pending until its result names a model", async ($, on) => {
    engine(on);

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolUse",
        props: { ...AGENT, isRunning: true, output: undefined },
    });

    expect(await ui.findAll({ type: "Text", text: /pending/ })).toHaveLength(1);
    await ui.unmount();
});

test("a mid-run model swap lists each model in order", async ($, on) => {
    engine(on);

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolUse",
        props: {
            ...AGENT,
            output: {
                ...SONNET,
                resolvedModel: "claude-opus-5-5",
                modelsUsed: ["claude-haiku-4-5-20251001", "claude-opus-5-5"],
            },
        },
    });

    expect(await ui.findAll({ type: "Text", text: /haiku-4-5 → opus-5-5/ })).toHaveLength(1);
    await ui.unmount();
});

test("a folded group lists the model of each Agent call and leaves the other calls out", async ($, on) => {
    engine(on);

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: {
            calls: [AGENT, { ...AGENT, tool_use_id: "toolu_c", output: HAIKU }, SHELL],
            isActive: false,
            isExpanded: false,
        },
    });

    expect(await ui.findAll({ type: "Text", text: /sonnet-5-5 · haiku-5-5/ })).toHaveLength(1);
    await ui.unmount();
});

test("an expanded group draws no model line; each of its Agent rows does", async ($, on) => {
    engine(on);

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolGroup",
        props: { calls: [AGENT], isActive: false, isExpanded: true },
    });

    expect(await ui.findAll({ type: "Text", text: /sonnet/ })).toHaveLength(0);
    await ui.unmount();
});

test("a Bash row draws unchanged", async ($, on) => {
    engine(on);

    const ui = await $.ui.mount({
        plugin: "genesis-tools-mods",
        surface: "terminal",
        component: "ToolUse",
        props: SHELL,
    });

    expect(await ui.findAll({ type: "Text", text: /pending|unknown|sonnet/ })).toHaveLength(0);
    await ui.unmount();
});
