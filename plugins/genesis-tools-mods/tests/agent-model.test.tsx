import type { AgentSpawnInput, On } from "claude-code";
import { expect, test } from "claude-code/testing";

// Run with `claude plugin test plugins/genesis-tools-mods`, with the fold tests.

/** The engine's own spawn, beneath the plugin: records the description the plugin passed down. */
function engine(on: On, seen: string[]): void {
    on("agent.spawn", async (_$, e) => {
        seen.push(e.description);

        return { model: "claude-sonnet-5-5", agentId: `agent-${seen.length}` };
    });
}

function spawn(description: string, extra: Partial<AgentSpawnInput> = {}): AgentSpawnInput {
    return {
        tool_use_id: `toolu_${description.replace(/\W/g, "")}`,
        prompt: "Reply with the word ok.",
        description,
        subagentType: "general-purpose",
        provider: { plugin: "engine", tier: "core" },
        parentModel: "claude-opus-5-5[1m]",
        background: true,
        fork: false,
        ...extra,
    };
}

test("a spawn that names its model shows it in the description", async ($, on) => {
    const seen: string[] = [];
    engine(on, seen);

    await $.agent.spawn(spawn("Pair one", { model: "sonnet" }));
    await $.agent.spawn(spawn("Pair two", { model: "claude-haiku-4-5-20251001" }));

    expect(seen).toEqual(["Pair one · sonnet", "Pair two · haiku-4-5"]);
});

test("a fork shows the parent's model, which it always inherits", async ($, on) => {
    const seen: string[] = [];
    engine(on, seen);

    await $.agent.spawn(spawn("Fork it", { fork: true, model: "haiku" }));

    expect(seen).toEqual(["Fork it · opus-5-5[1m]"]);
});

test("a spawn that names no model keeps its description", async ($, on) => {
    const seen: string[] = [];
    engine(on, seen);

    await $.agent.spawn(spawn("Explore the repo"));

    expect(seen).toEqual(["Explore the repo"]);
});
