import { asBoolean, boolOr, type HookConfigSection, partOf } from "@genesiscz/utils/agents/hooks/config-section";

/** The genesis-tools plugin's SessionStart reminder about the agents-talk skill. */
export interface AgentsTalkConfig {
    hint: boolean;
}

/** The agents-talk reminder's part of `hooks.json`. The plugin hook reads the same key standalone. */
export const AGENTS_TALK_HOOK_SECTION: HookConfigSection<AgentsTalkConfig> = {
    key: "agentsTalk",
    defaults: () => ({ hint: true }),
    merge: (stored) => ({ hint: boolOr(partOf(stored).hint, true) }),
    settable: ["agentsTalk.hint"],
    owns: (key) => key === "agentsTalk.hint",
    set: (current, key, value) => ({ ...current, hint: asBoolean(key, value) }),
    // The plugin's own SessionStart hook shows it; the agents hooks wire nothing for it.
    entries: () => [],
    doctor: (agentsTalk) => [["agentsTalk.hint", String(agentsTalk.hint)]],
};
