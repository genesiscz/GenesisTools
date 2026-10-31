import {
    asBoolean,
    asSwitch,
    boolOr,
    type HookConfigSection,
    loadHookConfigSection,
    partOf,
} from "@genesiscz/utils/agents/hooks/config-section";
import { ACCOUNT_PROVIDER_ALIASES, byHarness } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import pc from "picocolors";

/**
 * The agents' own structural questions (`tools agents hooks set questions on`): a question tool (Claude
 * `AskUserQuestion`, Codex `request_user_input`, Grok `ask_user_question`), a plan to approve, or a permission prompt,
 * recorded as one dialog record per question (`~/.genesis-tools/agents/dialogs/`, identity
 * `provider:sessionId:toolCallId`) that the hub inbox, the widget and the answer guard read. Everything ships OFF.
 *
 * Per harness, because each one exposes the questions differently: Claude through its hooks (PreToolUse and
 * PostToolUse on the question tools, Notification for a permission prompt); Grok through the same entries (it runs
 * Claude's `settings.json` hooks) plus the hub watcher for its permission prompts, which no Grok hook sees; Codex
 * through the hub watcher only, since its hooks reach shell calls alone.
 */
export interface QuestionsConfig {
    harnesses: Record<HarnessId, boolean>;
    /** A banner when the hub watcher sees a newly recorded question that waits for the user. */
    notify: boolean;
}

function defaults(): QuestionsConfig {
    return { harnesses: byHarness(() => false), notify: true };
}

function merge(stored: unknown, _problems: string[]): QuestionsConfig {
    const base = defaults();
    const part = partOf(stored);
    const harnesses = partOf(part.harnesses);

    return {
        harnesses: byHarness((id) => boolOr(harnesses[id], base.harnesses[id])),
        notify: boolOr(part.notify, base.notify),
    };
}

/** The harness a `questions.<harness>` or `questions.harnesses.<harness>` key names. */
function harnessOf(key: string): HarnessId | undefined {
    return ACCOUNT_PROVIDER_ALIASES.find(
        (name) => key === `questions.${name}` || key === `questions.harnesses.${name}`
    );
}

/**
 * `questions on|off` switches every harness; `questions.<harness>` (or `questions.harnesses.<harness>`) one of them;
 * `questions.notify` the hub watcher's banner. Turning a harness on needs `tools agents hooks install --write`
 * afterwards for the Claude and Grok hook entries.
 */
function set(current: QuestionsConfig, key: string, value: string): QuestionsConfig {
    const questions = { ...current, harnesses: { ...current.harnesses } };

    if (key === "questions") {
        const on = asSwitch(key, value);

        for (const harness of ACCOUNT_PROVIDER_ALIASES) {
            questions.harnesses[harness] = on;
        }

        return questions;
    }

    if (key === "questions.notify") {
        questions.notify = asBoolean(key, value);
        return questions;
    }

    const harness = harnessOf(key);

    if (!harness) {
        throw new Error(`unknown questions key: ${key}`);
    }

    questions.harnesses[harness] = asSwitch(key, value);
    return questions;
}

/** The questions feature's part of `hooks.json`, owned beside the dialog records it fills. */
export const QUESTIONS_HOOK_SECTION: HookConfigSection<QuestionsConfig> = {
    key: "questions",
    defaults,
    merge,
    settable: ["questions", `questions.<${ACCOUNT_PROVIDER_ALIASES.join("|")}>`, "questions.notify"],
    owns: (key) => key === "questions" || key === "questions.notify" || harnessOf(key) !== undefined,
    set,
    entries: (questions, overrides) =>
        (overrides.questions ?? questionHooksWanted({ questions })) ? ["questions"] : [],
    // The feature per harness (`tools agents hooks config set questions.<harness> on`), all off by default.
    doctor: (questions) => [
        [
            "questions per harness",
            ACCOUNT_PROVIDER_ALIASES.map((id) => `${id} ${questions.harnesses[id] ? "on" : pc.dim("off")}`).join(" · "),
        ],
    ],
};

/** The questions settings as the hooks load them, for the inbox and the hub. */
export function loadQuestionsHookConfig(): QuestionsConfig {
    return loadHookConfigSection(QUESTIONS_HOOK_SECTION);
}

/**
 * Whether Claude's `settings.json` needs the question hooks: a harness that runs those hooks (Claude, and Grok, which
 * reads Claude's) has the feature on. Codex is served by the hub watcher alone.
 */
export function questionHooksWanted({ questions }: { questions: QuestionsConfig }): boolean {
    return ACCOUNT_PROVIDER_ALIASES.some((id) => questions.harnesses[id] && harnessHooks(id).runsClaudeSettingsHooks);
}
