// The model a subagent runs on, put in front of its description, so the agents panel row reads
// `general-purpose  sonnet · Pair one`: the model right after the agent's type, which no hook can rename (a
// `subagentType` rewrite starts another agent) and the panel draws itself. Two hooks, because the places that draw a description
// read it at two different moments (live probes, 2026-10-22):
// - The `N background agents launched` block (`├ sonnet · Pair one`) and the Agent row draw the arguments the
//   model's response recorded. A `tool.call` or `agent.spawn` rewrite comes too late for them, so `turn.step`
//   rewrites the Agent call's argument JSON as it streams: what leaves the outermost hook is shown and recorded.
// - The agents panel row and the `Agent "…" finished` line draw the description `agent.spawn` passes on, which
//   also covers a fork (its model is the parent's, known only at the spawn) and a call a plugin made.
//
// Named only when the model is known before the spawn: the call's `model` parameter, or the parent's model for a
// fork. Without either, the agent's own definition or the default subagent model decides later, so the
// description stays as it was rather than guess.
import type { AgentSpawnInput, HookStream, TurnStepChunk, TurnStepResult } from "claude-code";
import { isRecord } from "./shared";

export type Format = "label" | "short";

const LETTERS: Record<string, string> = { opus: "O", sonnet: "S", fable: "F", haiku: "H" };

/**
 * `label`: `claude-sonnet-5-5` shows as `sonnet-5-5`, a dated id loses its date, an alias such as `sonnet` stays.
 * `short` (`mods.agentModel.format`): one letter per family, O S F H, else the label.
 */
export function modelLabel(id: string, format: Format): string {
    const label = id.replace(/^claude-/, "").replace(/-\d{8}$/, "");

    if (format === "label") {
        return label;
    }

    const family = Object.keys(LETTERS).find((name) => label.startsWith(name));

    return family ? (LETTERS[family] ?? label) : label;
}

/** `sonnet · Pair one`, or `(S) Pair one` in the short form; a description that already has it stays. */
function withModel(description: string, label: string, format: Format): string {
    const prefix = format === "short" ? `(${label}) ` : `${label} · `;

    return description.startsWith(prefix) ? description : `${prefix}${description}`;
}

/** Agent arguments with the model in the description, or `undefined` when they stay as the model wrote them. */
function labelled(input: unknown, format: Format): Record<string, unknown> | undefined {
    if (!isRecord(input) || typeof input.description !== "string" || typeof input.model !== "string") {
        return undefined;
    }

    if (input.subagent_type === "fork") {
        return undefined;
    }

    return { ...input, description: withModel(input.description, modelLabel(input.model, format), format) };
}

/** The argument JSON of one Agent block, rewritten when it parses and names a model; else as streamed. */
function rewrittenJson(json: string, format: Format): string {
    try {
        const next = labelled(JSON.parse(json), format);

        return next ? JSON.stringify(next) : json;
    } catch {
        // Broken JSON stays broken: the engine reports it as the model wrote it.
        return json;
    }
}

/** The turn.step stage: each Agent call's argument JSON is held until it ends, then passed on with the model in it. */
export async function* agentModelStep(
    stream: HookStream<TurnStepChunk, TurnStepResult | undefined>,
    format: Format
): AsyncGenerator<TurnStepChunk, TurnStepResult | undefined> {
    const agentBlocks = new Set<number>();
    const held = new Map<number, string>();

    function* release(): Generator<TurnStepChunk> {
        for (const [index, json] of held) {
            yield { kind: "input", index, json: rewrittenJson(json, format) };
        }

        held.clear();
    }

    for await (const chunk of stream) {
        if (chunk.kind === "tool" && chunk.name === "Agent") {
            yield* release();
            agentBlocks.add(chunk.index);
            held.set(chunk.index, "");
            yield chunk;
            continue;
        }

        if (chunk.kind === "input" && agentBlocks.has(chunk.index)) {
            held.set(chunk.index, (held.get(chunk.index) ?? "") + chunk.json);
            continue;
        }

        // The first chunk after an Agent block's arguments (its block end, the next block, the stop) releases them.
        yield* release();
        yield chunk;
    }

    yield* release();

    // Patched too, so a hook above reads the arguments as recorded. A test stub at the bottom returns none.
    const result: TurnStepResult | undefined = await stream.result;

    if (!result) {
        return result;
    }

    return {
        ...result,
        toolUses: result.toolUses.map((use) =>
            use.name === "Agent" ? { ...use, input: labelled(use.input, format) ?? use.input } : use
        ),
    };
}

/** The agent.spawn input with the model in front of its description, when the model is known before the spawn. */
export function spawnWithModel(e: AgentSpawnInput, format: Format): AgentSpawnInput {
    const model = e.fork ? e.parentModel : e.model;

    return model ? { ...e, description: withModel(e.description, modelLabel(model, format), format) } : e;
}
