import { existsSync } from "node:fs";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import type { HarnessName } from "./config";

/** Claude's question tools, and Grok's names for its own, since Grok runs the same `settings.json` entries. */
export const QUESTION_TOOL_KINDS: Readonly<Record<string, "decision" | "plan">> = {
    AskUserQuestion: "decision",
    ExitPlanMode: "plan",
    ask_user_question: "decision",
    exit_plan_mode: "plan",
};

/** The PreToolUse matcher of the question hook: only a question tool starts it before the call. */
export const QUESTION_TOOL_MATCHER = Object.keys(QUESTION_TOOL_KINDS).join("|");

/**
 * Whether the session has a dialog record file at all, checked before the question hook loads the store. The
 * hook runs on every PostToolUse while the feature is on, and the store imports the logger (about 10 ms), so a
 * session that never asked exits after this one `stat`.
 *
 * 🛑 The same layout as `dialogsPath` in `@genesiscz/utils/agents/dialogs/store`, which this must not import;
 * `questions.test.ts` holds the two equal.
 */
export function hasDialogRecords(harness: HarnessName, sessionId: string | undefined): boolean {
    if (!sessionId || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
        return false;
    }

    return existsSync(genesisToolsDir("agents", "dialogs", harness, `${sessionId}.json`));
}
