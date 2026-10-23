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
import type { On, TurnStepChunk, TurnStepResult } from "claude-code";

/** `claude-sonnet-5-5` shows as `sonnet-5-5`; a dated id loses its date; an alias such as `sonnet` stays. */
function modelLabel(id: string): string {
    return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function withModel(description: string, label: string): string {
    const prefix = `${label} · `;

    return description.startsWith(prefix) ? description : `${prefix}${description}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Agent arguments with the model in the description, or `undefined` when they stay as the model wrote them. */
function labelled(input: unknown): Record<string, unknown> | undefined {
    if (!isRecord(input) || typeof input.description !== "string" || typeof input.model !== "string") {
        return undefined;
    }

    if (input.subagent_type === "fork") {
        return undefined;
    }

    return { ...input, description: withModel(input.description, modelLabel(input.model)) };
}

/** The argument JSON of one Agent block, rewritten when it parses and names a model; else as streamed. */
function rewrittenJson(json: string): string {
    try {
        const next = labelled(JSON.parse(json));

        return next ? JSON.stringify(next) : json;
    } catch {
        // Broken JSON stays broken: the engine reports it as the model wrote it.
        return json;
    }
}

export function agentModelHooks(on: On): void {
    on("turn.step", async function* (_$, e, next) {
        const stream = next(e);
        const agentBlocks = new Set<number>();
        const held = new Map<number, string>();

        function* release(): Generator<TurnStepChunk> {
            for (const [index, json] of held) {
                yield { kind: "input", index, json: rewrittenJson(json) };
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
                use.name === "Agent" ? { ...use, input: labelled(use.input) ?? use.input } : use
            ),
        };
    });

    on("agent.spawn", (_$, e, next) => {
        const model = e.fork ? e.parentModel : e.model;

        if (!model) {
            return next(e);
        }

        return next({ ...e, description: withModel(e.description, modelLabel(model)) });
    });
}
