// The short name of a model id, for the agent-model mod, the agents band and the agents panel rows (`agent-row.ts`).
// No engine types here: the CLI's row command (`src/agents/bin/hook-subagent-line.ts`) imports it.

export type Format = "label" | "short" | "version";

const LETTERS: Record<string, string> = { opus: "O", sonnet: "S", fable: "F", haiku: "H" };

/**
 * `label`: `claude-sonnet-5-5` shows as `sonnet-5-5`, a dated id loses its date, an alias such as `sonnet` stays.
 * `short` (`mods.agentModel.format`): one letter per family, O S F H, else the label.
 * `version`: the letter and the version, `O5.5`; an alias without a version is the letter alone.
 */
export function modelLabel(id: string, format: Format): string {
    const label = id.replace(/^claude-/, "").replace(/-\d{8}$/, "");

    if (format === "label") {
        return label;
    }

    const family = Object.keys(LETTERS).find((name) => label.startsWith(name));
    const letter = family ? LETTERS[family] : undefined;

    if (!family || !letter) {
        return label;
    }

    const version = format === "version" ? /^-(\d+(?:-\d+)*)/.exec(label.slice(family.length))?.[1] : undefined;

    return version ? `${letter}${version.replaceAll("-", ".")}` : letter;
}

/** The model with the effort it runs at: `O5.5(xhigh)`, `sonnet-5-5 (high)`; no effort, the model alone. */
export function withEffort(label: string, effort: string | undefined, format: Format): string {
    if (!effort) {
        return label;
    }

    return format === "label" ? `${label} (${effort})` : `${label}(${effort})`;
}

/** What the agent-model mod puts in front of a description: `sonnet · ` (`label`), `(S) ` or `(S5.5) `. */
export function modelPrefix(label: string, format: Format): string {
    return format === "label" ? `${label} · ` : `(${label}) `;
}

/** A description without the model the agent-model mod put in front (`(H) `, `(H5.5) `, `haiku-5-5 · `). */
export function bareDescription(description: string): string {
    return description.replace(/^\([A-Z][\d.]*\) /, "").replace(/^[a-z]+(?:-[\w.]+)* · /, "");
}
