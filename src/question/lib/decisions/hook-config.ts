import {
    asBoolean,
    asCount,
    boolOr,
    countOr,
    type HookConfigSection,
    listed,
    loadHookConfigSection,
    oneOf,
    partOf,
} from "@genesiscz/utils/agents/hooks/config-section";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { SafeJSON } from "@genesiscz/utils/json";

export type DecisionStopHook = "off" | "warn" | "block";
export const DECISION_CHAT_ANSWERS = ["off", "record", "remind"] as const;
export type DecisionChatAnswers = (typeof DECISION_CHAT_ANSWERS)[number];

/**
 * The decision hub's optional hooks. Everything ships OFF, and `tools agents hooks install` only
 * wires the Stop and UserPromptSubmit entries once one of them is turned on here.
 */
export interface DecisionsHookConfig {
    /**
     * A final reply that asks `❓ DECISION N` without posting it through question_post: `warn`
     * tells the user, `block` sends the agent back to post it, at most `maxBlocksPerSession`
     * times per session, then it only warns (the loop guard).
     */
    stopHook: DecisionStopHook;
    /**
     * A final reply that asks the user to decide (a cue: the word decision, decisions, decide or
     * choose, or ❓; and a sentence that ends in "?", both outside code and quotes) while this
     * session logged no decision since the turn's prompt: `warn` tells the user, `block` sends the
     * agent back once per turn to post it with question_post. A reply that names `❓ DECISION N`
     * belongs to `stopHook`. Its blocks count against `maxBlocksPerSession` apart from `stopHook`'s.
     * It needs only the Stop entry, so turning it on wires no UserPromptSubmit hook.
     */
    questionNudge: DecisionStopHook;
    /**
     * Answers the user typed in the chat to an open `❓ DECISION N` (`D14 b)`), read from the session's transcript
     * after the decision was asked, through its provider's `readBackward`. `record`: an unambiguous answer is stored
     * as acknowledged with `answeredVia: "automatic_heuristic"`, and the agent is sent back once per unclear one to
     * record it; `remind`: nothing is stored, the agent is sent back once per decision to record what it finds;
     * `off`. It needs only the Stop entry.
     */
    chatAnswers: DecisionChatAnswers;
    maxBlocksPerSession: number;
    harnesses: HarnessId[];
    /** Safety net: store an unposted `❓ DECISION N` block as an open decision under its number. */
    harvest: boolean;
    /**
     * The inbox (`tools question inbox`, the hub) stores the unposted `❓ DECISION N` blocks it lists as open decisions
     * under their numbers, so the widget counts them and every surface can answer them; the widget reads the decision
     * log only, so it counted one fewer than the hub (2026-10-27, decision audit F6). Default on. The agent's own post
     * of that number later becomes the decision's next revision.
     */
    harvestListed: boolean;
    /** UserPromptSubmit: hand answered, undelivered decisions to the session's next prompt. */
    injectAnswers: boolean;
    /**
     * A blocking decision still waiting this long raises one notification per threshold. Read by
     * `tools question stale --notify`, which `tools question stale --install` runs every 5 minutes.
     */
    staleness: { warnAfterMinutes: number; alarmAfterMinutes: number; notify: boolean };
}

const STOP_HOOK_MODES: readonly DecisionStopHook[] = ["off", "warn", "block"];

const DEFAULT_DECISIONS: DecisionsHookConfig = {
    stopHook: "off",
    questionNudge: "off",
    chatAnswers: "off",
    maxBlocksPerSession: 2,
    harnesses: [...ACCOUNT_PROVIDER_ALIASES],
    harvest: false,
    harvestListed: true,
    injectAnswers: false,
    staleness: { warnAfterMinutes: 30, alarmAfterMinutes: 120, notify: true },
};

function defaults(): DecisionsHookConfig {
    return {
        ...DEFAULT_DECISIONS,
        harnesses: [...DEFAULT_DECISIONS.harnesses],
        staleness: { ...DEFAULT_DECISIONS.staleness },
    };
}

function merge(value: unknown, problems: string[]): DecisionsHookConfig {
    const base = DEFAULT_DECISIONS;
    const stored = partOf(value);
    const staleness = partOf(stored.staleness);
    const harnesses = Array.isArray(stored.harnesses)
        ? stored.harnesses.filter((name): name is HarnessId => ACCOUNT_PROVIDER_ALIASES.some((id) => id === name))
        : base.harnesses;

    return {
        stopHook: oneOf(stored.stopHook, STOP_HOOK_MODES, base.stopHook),
        questionNudge: oneOf(stored.questionNudge, STOP_HOOK_MODES, base.questionNudge),
        chatAnswers: oneOf(stored.chatAnswers, DECISION_CHAT_ANSWERS, base.chatAnswers),
        maxBlocksPerSession: countOr(problems, {
            field: "decisions.maxBlocksPerSession",
            value: stored.maxBlocksPerSession,
            fallback: base.maxBlocksPerSession,
            min: 0,
        }),
        harnesses,
        harvest: boolOr(stored.harvest, base.harvest),
        harvestListed: boolOr(stored.harvestListed, base.harvestListed),
        injectAnswers: boolOr(stored.injectAnswers, base.injectAnswers),
        staleness: {
            warnAfterMinutes: countOr(problems, {
                field: "decisions.staleness.warnAfterMinutes",
                value: staleness.warnAfterMinutes,
                fallback: base.staleness.warnAfterMinutes,
            }),
            alarmAfterMinutes: countOr(problems, {
                field: "decisions.staleness.alarmAfterMinutes",
                value: staleness.alarmAfterMinutes,
                fallback: base.staleness.alarmAfterMinutes,
            }),
            notify: boolOr(staleness.notify, base.staleness.notify),
        },
    };
}

const SETTABLE = [
    "decisions.stopHook",
    "decisions.questionNudge",
    "decisions.chatAnswers",
    "decisions.maxBlocksPerSession",
    "decisions.harnesses",
    "decisions.harvest",
    "decisions.harvestListed",
    "decisions.injectAnswers",
    "decisions.staleness.<warnAfterMinutes|alarmAfterMinutes|notify>",
] as const;

const DECISION_KEYS: ReadonlySet<string> = new Set([
    ...SETTABLE.filter((key) => !key.includes("<")),
    "decisions.staleness.warnAfterMinutes",
    "decisions.staleness.alarmAfterMinutes",
    "decisions.staleness.notify",
]);

/** One `decisions.*` key. The stop hook and the question nudge take off|warn|block; `harnesses` a comma list. */
function set(current: DecisionsHookConfig, key: string, value: string): DecisionsHookConfig {
    const decisions = { ...current, staleness: { ...current.staleness } };

    switch (key) {
        case "decisions.stopHook":
        case "decisions.questionNudge": {
            const mode = STOP_HOOK_MODES.find((choice) => choice === value);

            if (!mode) {
                throw new Error(`${key} takes off, warn or block, not ${SafeJSON.stringify(value)}`);
            }

            decisions[key === "decisions.stopHook" ? "stopHook" : "questionNudge"] = mode;
            return decisions;
        }
        case "decisions.chatAnswers": {
            const mode = DECISION_CHAT_ANSWERS.find((choice) => choice === value);

            if (!mode) {
                throw new Error(`${key} takes ${listed(DECISION_CHAT_ANSWERS)}, not ${SafeJSON.stringify(value)}`);
            }

            decisions.chatAnswers = mode;
            return decisions;
        }
        case "decisions.maxBlocksPerSession":
            decisions.maxBlocksPerSession = asCount(key, value, 0);
            return decisions;
        case "decisions.harnesses": {
            const names = value
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean);
            const known = names.filter((name): name is HarnessId => ACCOUNT_PROVIDER_ALIASES.some((id) => id === name));
            const unknown = names.filter((name) => !ACCOUNT_PROVIDER_ALIASES.some((id) => id === name));

            if (unknown.length > 0) {
                throw new Error(`no such harness: ${unknown.join(", ")}`);
            }

            decisions.harnesses = known;
            return decisions;
        }
        case "decisions.harvest":
            decisions.harvest = asBoolean(key, value);
            return decisions;
        case "decisions.harvestListed":
            decisions.harvestListed = asBoolean(key, value);
            return decisions;
        case "decisions.injectAnswers":
            decisions.injectAnswers = asBoolean(key, value);
            return decisions;
        case "decisions.staleness.warnAfterMinutes":
        case "decisions.staleness.alarmAfterMinutes":
            decisions.staleness[key.endsWith("warnAfterMinutes") ? "warnAfterMinutes" : "alarmAfterMinutes"] = asCount(
                key,
                value
            );
            return decisions;
        case "decisions.staleness.notify":
            decisions.staleness.notify = asBoolean(key, value);
            return decisions;
        default:
            throw new Error(`unknown decisions key: ${key}. Settable: ${SETTABLE.join(", ")}`);
    }
}

/** The decision hub's part of `hooks.json`: owned here, beside the decision log, and listed by the agents hooks. */
export const DECISIONS_HOOK_SECTION: HookConfigSection<DecisionsHookConfig> = {
    key: "decisions",
    defaults,
    merge,
    settable: SETTABLE,
    owns: (key) => DECISION_KEYS.has(key),
    set,
    // The Stop entry runs every decision check; UserPromptSubmit only the hub's own (harvest, answers, the stop hook).
    entries: (decisions, overrides) => [
        ...((overrides.decisions ?? decisionHooksWanted({ decisions })) ? (["stop", "prompt"] as const) : []),
        ...((overrides.questionNudge ?? stopOnlyDecisionsWanted({ decisions })) ? (["stop"] as const) : []),
    ],
    doctor: (decisions) => [
        ["decisions.stopHook", decisions.stopHook],
        ["decisions.questionNudge", decisions.questionNudge],
        ["decisions.chatAnswers", decisions.chatAnswers],
    ],
};

/** The decision hooks' settings as the hooks load them, for the question tool and the hub. */
export function loadDecisionsHookConfig(): DecisionsHookConfig {
    return loadHookConfigSection(DECISIONS_HOOK_SECTION);
}

/** Whether the decision hub needs its Stop and UserPromptSubmit hooks wired at all. */
export function decisionHooksWanted({ decisions }: { decisions: DecisionsHookConfig }): boolean {
    return decisions.stopHook !== "off" || decisions.harvest || decisions.injectAnswers;
}

/** Whether the Stop hook has decision work: the hub's own checks, or the question nudge, which needs only Stop. */
export function decisionStopWanted(config: { decisions: DecisionsHookConfig }): boolean {
    return decisionHooksWanted(config) || stopOnlyDecisionsWanted(config);
}

/** The decision checks that need only the Stop entry: the question nudge and the chat answers. */
export function stopOnlyDecisionsWanted({ decisions }: { decisions: DecisionsHookConfig }): boolean {
    return decisions.questionNudge !== "off" || decisions.chatAnswers !== "off";
}
