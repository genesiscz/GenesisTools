// The model a subagent runs on, added to its description, which the agents panel row (`general-purpose  Pair one
// · sonnet  4s · ↓ 58k tokens`) and the `Agent "Pair one · sonnet" finished` line draw. No render hook reaches
// the panel (live probe, 2026-10-22). The Agent row needs nothing: the engine prints the model there itself. The
// `N background agents launched` block draws the model's own tool input, which neither this rewrite nor a
// `tool.call` rewrite changes (both tried live), so it stays without the model.
//
// Named only when the spawn knows it: the call's `model` parameter, or the parent's model for a fork. Without
// either, the agent's own definition or the default subagent model decides after this hook, so the description
// stays as it was rather than guess.
import type { On } from "claude-code";

/** `claude-sonnet-5-5` shows as `sonnet-5-5`; a dated id loses its date; an alias such as `sonnet` stays. */
function modelLabel(id: string): string {
    return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function withModel(description: string, label: string): string {
    const suffix = ` · ${label}`;

    return description.endsWith(suffix) ? description : `${description}${suffix}`;
}

export function agentModelHooks(on: On): void {
    on("agent.spawn", (_$, e, next) => {
        const model = e.fork ? e.parentModel : e.model;

        if (!model) {
            return next(e);
        }

        return next({ ...e, description: withModel(e.description, modelLabel(model)) });
    });
}
