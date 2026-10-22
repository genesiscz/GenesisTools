import type { AgentSpawnInput, On, TurnStepChunk } from "claude-code";
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

/** The model's response beneath the plugin: an Agent call that names a model, an Agent call that does not, a Bash call. */
function response(on: On): void {
    on("turn.step", async function* () {
        yield { kind: "tool", index: 0, id: "toolu_a", name: "Agent" };
        yield { kind: "input", index: 0, json: '{"description":"Pair one",' };
        yield { kind: "input", index: 0, json: '"prompt":"ok","model":"sonnet"}' };
        yield { kind: "tool", index: 1, id: "toolu_b", name: "Agent" };
        yield { kind: "input", index: 1, json: '{"description":"Explore","prompt":"ok"}' };
        yield { kind: "tool", index: 2, id: "toolu_c", name: "Bash" };
        yield { kind: "input", index: 2, json: '{"command":"ls"}' };
        yield { kind: "stop", stopReason: "tool_use", usage: null };

        return {
            turnId: "t1",
            index: 0,
            answer: "",
            toolUses: [
                { name: "Agent", input: { description: "Pair one", prompt: "ok", model: "sonnet" } },
                { name: "Agent", input: { description: "Explore", prompt: "ok" } },
                { name: "Bash", input: { command: "ls" } },
            ],
            stopReason: "tool_use",
            usage: null,
        };
    });
}

test("an Agent call's streamed arguments carry its model in the description, so the launch block shows it", async ($, on) => {
    response(on);

    const stream = $.turn.step({ turnId: "t1", index: 0, model: "claude-haiku-5-5", messageCount: 1 });
    const chunks: TurnStepChunk[] = [];

    for await (const chunk of stream) {
        chunks.push(chunk);
    }

    // The stream is what the screen draws and the transcript records. The harness gives a stub at the bottom no
    // step result, so the hook's patch of `toolUses` is checked live only.
    expect(
        chunks.map((chunk) => (chunk.kind === "input" ? `input ${chunk.index}: ${chunk.json}` : chunk.kind))
    ).toEqual([
        "tool",
        'input 0: {"description":"Pair one · sonnet","prompt":"ok","model":"sonnet"}',
        "tool",
        'input 1: {"description":"Explore","prompt":"ok"}',
        "tool",
        'input 2: {"command":"ls"}',
        "stop",
    ]);
});
