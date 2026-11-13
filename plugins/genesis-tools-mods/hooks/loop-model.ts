// The model each loop of the session runs on, for the `tools metrics` dims of the hook ledger and the resume guard.
// For any loop, the model of its last response as the API reported it comes first (`noteLoopModel`, from a step's or a
// turn's usage); the main loop has only this. Until a subagent has answered, the agents band's bookkeeping names it:
// the model `agent.spawn` answered (`spawned`), else the one its `agent-<id>.meta.json` names (`metas`).
// Unknown stays null: a setting such as the default subagent model is never read as the answer.
import { metas, spawned } from "./agents-band";
import type { Host } from "./shared";

/** The last answering model of each loop, by `main` or the agent id. */
const answered = new Map<string, string>();

/** Remembers the model a loop's response came from (`main` for the main loop). */
export function noteLoopModel(agent: string, model: string | undefined): void {
    if (model) {
        answered.set(agent, model);
    }
}

/**
 * The model of the loop `agent` (`main` or an agent id), or null while the plugin has not seen it. A response the
 * loop gave wins: the spawn and the meta file name the model the agent started on, which a later response can differ
 * from, so they only answer until a response was seen.
 */
export function loopModelOf(agent: string): string | null {
    const seen = answered.get(agent);

    if (seen) {
        return seen;
    }

    if (agent === "main") {
        return null;
    }

    return spawned[agent]?.model ?? metas.get(agent)?.model ?? null;
}

/**
 * `loopModelOf`, and for the main loop before its first response after a reload the model the session runs on now
 * (`$.session.model()`), so its events carry a model from the first one.
 */
export async function loopModel(host: Host, agent: string): Promise<string | null> {
    const known = loopModelOf(agent);

    if (known || agent !== "main") {
        return known;
    }

    return (await host.model().catch(() => "")) || null;
}

/** A test starts a different session. */
export function forgetLoopModels(): void {
    answered.clear();
}
