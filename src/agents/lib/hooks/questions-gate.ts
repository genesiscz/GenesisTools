import { existsSync } from "node:fs";
import { safeSessionId } from "@genesiscz/utils/agents/session-id";
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
 * Whether the session has an open dialog record, checked before the question hook loads the store. The hook runs on
 * every PostToolUse while the feature is on, and the store imports the logger (about 10 ms), so a session with no
 * open question exits after this one `stat` of the store's `<session>.open` marker.
 *
 * 🛑 The same layout as `dialogsPath` and `openMarkerPath` in `@genesiscz/utils/agents/dialogs/store`, which this must
 * not import; `hooks.test.ts` holds them equal.
 */
export function hasOpenDialogRecords(harness: HarnessName, sessionId: string | undefined): boolean {
    const id = safeSessionId(sessionId);

    if (!id) {
        return false;
    }

    return existsSync(genesisToolsDir("agents", "dialogs", harness, `${id}.open`));
}

/** Whether the one-time pass that gave older record files their open marker has run (`OPEN_MARKERS_INDEXED`). */
export function openMarkersIndexed(): boolean {
    return existsSync(genesisToolsDir("agents", "dialogs", ".open-markers-indexed"));
}
