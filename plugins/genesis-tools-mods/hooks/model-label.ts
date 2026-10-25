// The short name of a model id, for the agent-model mod, the agents band and the agents panel rows (`agent-row.ts`).
// No engine types here: the CLI's row command (`src/agents/bin/hook-subagent-line.ts`) imports it.

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

/** What the agent-model mod puts in front of a description: `sonnet · ` (`label`) or `(S) ` (`short`). */
export function modelPrefix(label: string, format: Format): string {
    return format === "short" ? `(${label}) ` : `${label} · `;
}

/** A description without the model the agent-model mod put in front (`(H) `, `haiku-5-5 · `): a row prints it once. */
export function bareDescription(description: string): string {
    return description.replace(/^\([A-Z]\) /, "").replace(/^[a-z]+(?:-[\w.]+)* · /, "");
}
