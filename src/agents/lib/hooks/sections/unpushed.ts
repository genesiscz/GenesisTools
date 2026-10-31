import {
    asBoolean,
    asCount,
    boolOr,
    countOr,
    type HookConfigSection,
    partOf,
} from "@genesiscz/utils/agents/hooks/config-section";

/**
 * The Stop-phase reminder about commits that are not pushed yet. It fires for a branch with an
 * upstream when MORE than `maxCommits` commits are unpushed, or when the oldest unpushed commit
 * is older than `maxAgeMinutes`, whichever comes first. One reminder per repository per
 * `remindEveryMinutes`, across every session on the machine. It never pushes.
 */
export interface UnpushedConfig {
    enabled: boolean;
    maxCommits: number;
    maxAgeMinutes: number;
    remindEveryMinutes: number;
}

const DEFAULT_UNPUSHED: UnpushedConfig = { enabled: true, maxCommits: 3, maxAgeMinutes: 60, remindEveryMinutes: 30 };

function merge(value: unknown, problems: string[]): UnpushedConfig {
    const base = DEFAULT_UNPUSHED;
    const stored = partOf(value);

    return {
        enabled: boolOr(stored.enabled, base.enabled),
        maxCommits: countOr(problems, {
            field: "unpushed.maxCommits",
            value: stored.maxCommits,
            fallback: base.maxCommits,
            min: 0,
        }),
        maxAgeMinutes: countOr(problems, {
            field: "unpushed.maxAgeMinutes",
            value: stored.maxAgeMinutes,
            fallback: base.maxAgeMinutes,
        }),
        remindEveryMinutes: countOr(problems, {
            field: "unpushed.remindEveryMinutes",
            value: stored.remindEveryMinutes,
            fallback: base.remindEveryMinutes,
            min: 0,
        }),
    };
}

function set(current: UnpushedConfig, key: string, value: string): UnpushedConfig {
    const field = key.slice("unpushed.".length);

    if (field === "enabled") {
        return { ...current, enabled: asBoolean(key, value) };
    }

    if (field === "maxCommits" || field === "remindEveryMinutes") {
        return { ...current, [field]: asCount(key, value, 0) };
    }

    if (field === "maxAgeMinutes") {
        return { ...current, maxAgeMinutes: asCount(key, value) };
    }

    throw new Error(`unknown key: ${key}. Settable: unpushed.enabled, maxCommits, maxAgeMinutes, remindEveryMinutes`);
}

/** The unpushed-commits reminder's part of `hooks.json`. */
export const UNPUSHED_HOOK_SECTION: HookConfigSection<UnpushedConfig> = {
    key: "unpushed",
    defaults: () => ({ ...DEFAULT_UNPUSHED }),
    merge,
    settable: ["unpushed.<enabled|maxCommits|maxAgeMinutes|remindEveryMinutes>"],
    owns: (key) => key.startsWith("unpushed."),
    set,
    // The reminder runs in the Stop entry.
    entries: (unpushed, overrides) => ((overrides.unpushed ?? unpushed.enabled) ? ["stop"] : []),
    doctor: () => [],
};
