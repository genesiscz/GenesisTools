import {
    type ConfigPreset,
    type HookConfigSection,
    listed,
    partOf,
} from "@genesiscz/utils/agents/hooks/config-section";
import {
    ACCOUNT_PROVIDER_ALIASES,
    type AccountProviderAlias,
    byHarness,
    type PerHarness,
} from "@genesiscz/utils/ai/providers/alias-list";
import { SafeJSON } from "@genesiscz/utils/json";

/** How an area file reaches the agent: its whole text, one pointer line, or not at all. */
export type AreaRuleLevel = "full" | "pointer" | "off";
/** What a subagent gets: the same as the main agent, at most a pointer, or nothing. */
export type AreaRuleAgents = "same" | "pointer" | "off";

/**
 * Only a write gets the rules (Martin, 2026-11-11: a read never needs them). Claude Code loads a rule file by itself on
 * its Read, Write and Edit tools; a Bash write passes that loader by, and Codex and Grok have no such loader at all.
 * A stored `read` key from the first version of this section is ignored.
 */
export interface AreaRulesLevels {
    /**
     * A Bash command that writes into the area: a redirect, `sed -i`, `mv` into it, a formatter with `--write`,
     * fable-replace, or an inline script (`python3 -c`, `bun -e`, an interpreter fed a here-document).
     */
    write: AreaRuleLevel;
    agents: AreaRuleAgents;
}

/**
 * The genesis-tools plugin's area-rules hook (`plugins/genesis-tools/hooks/area-rules.ts`): one set of levels for
 * every harness, and each harness's overrides over it. The plugin hook reads this part of `hooks.json` itself.
 */
export interface AreaRulesConfig extends AreaRulesLevels {
    harnesses: PerHarness<Partial<AreaRulesLevels>>;
}

const LEVELS: readonly AreaRuleLevel[] = ["full", "pointer", "off"];
const AGENTS: readonly AreaRuleAgents[] = ["same", "pointer", "off"];
const FIELDS = ["write", "agents"] as const;
type Field = (typeof FIELDS)[number];
const CHOICES: { readonly [Name in Field]: readonly string[] } = { write: LEVELS, agents: AGENTS };

/** `AREA_RULES_DEFAULTS` in the plugin hook mirrors this, and `hooks.test.ts` holds the two equal. */
const DEFAULT_AREA_RULES: AreaRulesConfig = {
    write: "full",
    agents: "same",
    harnesses: byHarness(() => ({})),
};

const WRITE_PRESETS: readonly ConfigPreset[] = [
    {
        name: "full",
        value: "full",
        why: "The whole rule file when a Bash command writes into the area, once per agent and not when Claude Code already loaded it: the change is being made, so the rules must be in context.",
    },
    {
        name: "pointer",
        value: "pointer",
        why: "One line per rule file (its path, its length and its scope) with an instruction to read it before changing code there. About 40 tokens instead of 1,210 on average.",
    },
    {
        name: "off",
        value: "off",
        why: "Nothing from this hook. Claude Code still loads a rule file on its own Read, Write and Edit tools, but a Bash write (`sed -i`, an inline script, fable-replace) gets no rules, and Codex and Grok get none at all.",
    },
];

const AGENT_PRESETS: readonly ConfigPreset[] = [
    { name: "same", value: "same", why: "A subagent gets what the main agent would get." },
    {
        name: "pointer",
        value: "pointer",
        why: "A subagent gets pointer lines only, never a whole file. 78% of the hook context went to subagents.",
    },
    {
        name: "off",
        value: "off",
        why: "A subagent gets nothing from this hook; only the main agent does. The hook exits at once for a subagent's search.",
    },
];

function presetsOf(field: Field): readonly ConfigPreset[] {
    return field === "agents" ? AGENT_PRESETS : WRITE_PRESETS;
}

const AREA_RULES_PRESETS: Record<string, readonly ConfigPreset[]> = Object.fromEntries(
    FIELDS.flatMap((field) => [
        [`areaRules.${field}`, presetsOf(field)],
        ...ACCOUNT_PROVIDER_ALIASES.map((harness) => [`areaRules.harnesses.${harness}.${field}`, presetsOf(field)]),
    ])
);

const HARNESS_KEY = /^areaRules\.harnesses\.([^.]+)\.([^.]+)$/;

function harnessNamed(name: string | undefined): AccountProviderAlias | undefined {
    return ACCOUNT_PROVIDER_ALIASES.find((harness) => harness === name);
}

function fieldNamed(name: string | undefined): Field | undefined {
    return FIELDS.find((field) => field === name);
}

/** The field a settable key names, and the harness when it is a per-harness key. */
function keyOf(key: string): { field: Field; harness?: AccountProviderAlias } | null {
    const global = fieldNamed(key.startsWith("areaRules.") ? key.slice("areaRules.".length) : undefined);
    if (global) {
        return { field: global };
    }

    const match = HARNESS_KEY.exec(key);
    const harness = harnessNamed(match?.[1]);
    const field = fieldNamed(match?.[2]);
    return harness && field ? { field, harness } : null;
}

/** The fields of a stored part that hold a valid value, each wrong one named in `problems`. */
function checkedLevels(stored: unknown, path: string, problems: string[]): Partial<AreaRulesLevels> {
    const part = partOf(stored);
    const out: Partial<AreaRulesLevels> = {};
    for (const field of FIELDS) {
        const value = part[field];
        if (value === undefined) {
            continue;
        }

        if (field === "agents") {
            const agents = AGENTS.find((choice) => choice === value);
            if (agents) {
                out.agents = agents;
                continue;
            }
        } else {
            const level = LEVELS.find((choice) => choice === value);
            if (level) {
                out[field] = level;
                continue;
            }
        }

        problems.push(`${path}.${field} is ${SafeJSON.stringify(value)}, not ${listed(CHOICES[field])}; ignored`);
    }

    return out;
}

function copied(config: AreaRulesConfig): AreaRulesConfig {
    return {
        ...config,
        harnesses: byHarness((harness) => ({ ...config.harnesses[harness] })),
    };
}

function asChoice(field: Field, key: string, value: string): AreaRulesLevels[Field] {
    const choice =
        field === "agents"
            ? AGENTS.find((candidate) => candidate === value)
            : LEVELS.find((candidate) => candidate === value);
    if (!choice) {
        throw new Error(`${key} takes ${listed(CHOICES[field])}, not ${SafeJSON.stringify(value)}`);
    }

    return choice;
}

function shown(levels: Partial<AreaRulesLevels>): string {
    return FIELDS.flatMap((field) => (levels[field] ? [`${field} ${levels[field]}`] : [])).join(", ");
}

/** The area-rules hook's part of `hooks.json`. */
export const AREA_RULES_HOOK_SECTION: HookConfigSection<AreaRulesConfig> = {
    key: "areaRules",
    defaults: () => copied(DEFAULT_AREA_RULES),
    merge: (stored, problems) => {
        const merged = copied(DEFAULT_AREA_RULES);
        const part = partOf(stored);
        const harnesses = partOf(part.harnesses);
        for (const harness of ACCOUNT_PROVIDER_ALIASES) {
            if (harnesses[harness] !== undefined) {
                merged.harnesses[harness] = {
                    ...merged.harnesses[harness],
                    ...checkedLevels(harnesses[harness], `areaRules.harnesses.${harness}`, problems),
                };
            }
        }

        return { ...merged, ...checkedLevels(part, "areaRules", problems) };
    },
    settable: [
        "areaRules.write",
        "areaRules.agents",
        `areaRules.harnesses.<${ACCOUNT_PROVIDER_ALIASES.join("|")}>.<${FIELDS.join("|")}>`,
    ],
    owns: (key) => keyOf(key) !== null,
    set: (current, key, value) => {
        const target = keyOf(key);
        if (!target) {
            throw new Error(`unknown key: ${key}`);
        }

        const next = copied(current);
        const choice = asChoice(target.field, key, value);
        if (target.harness) {
            next.harnesses[target.harness] = { ...next.harnesses[target.harness], [target.field]: choice };
            return next;
        }

        return { ...next, [target.field]: choice };
    },
    // The plugin's own PostToolUse hook does the work; the agents hooks wire nothing for it.
    entries: () => [],
    doctor: (areaRules) => [
        [
            "areaRules",
            [
                shown(areaRules),
                ...ACCOUNT_PROVIDER_ALIASES.flatMap((harness) => {
                    const own = shown(areaRules.harnesses[harness]);
                    return own ? [`${harness}: ${own}`] : [];
                }),
            ].join("; "),
        ],
    ],
    presets: AREA_RULES_PRESETS,
    inheritsFrom: (key) => {
        const target = keyOf(key);
        return target?.harness ? `areaRules.${target.field}` : undefined;
    },
};
