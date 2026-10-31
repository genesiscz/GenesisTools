#!/usr/bin/env bun
/**
 * The questions feature (`tools agents hooks config set questions on`): records an agent's structural question
 * (AskUserQuestion, ExitPlanMode, a permission prompt) as a dialog record, and closes it when the harness moves on.
 * Wired for PreToolUse on the question tools, PostToolUse and PostToolUseFailure, Notification, UserPromptSubmit and
 * SessionEnd. One bun start per call: a PostToolUse of a session with no open dialog record exits after one `stat`,
 * before the store and its logger load.
 */
import { env } from "@genesiscz/utils/env";
import { loadHooksConfig, megabytes } from "../lib/hooks/config";
import { hookDiag, logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { normalizeEvent, parseHookPayload } from "../lib/hooks/payload";
import { hasOpenDialogRecords, openMarkersIndexed } from "../lib/hooks/questions-gate";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();
const payload = parseHookPayload(await Bun.stdin.text());

if (!payload || !config.questions.harnesses[payload.harness]) {
    process.exit(0);
}

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const event = normalizeEvent(payload.event);
const asks = event === "pretooluse" || event === "notification";

if (!asks && !hasOpenDialogRecords(payload.harness, payload.sessionId)) {
    if (openMarkersIndexed()) {
        process.exit(0);
    }

    // Once per machine: record files from before the open markers get theirs, so their open records still close.
    // A failed pass must not block the tool call; the next call tries again, because the indexed flag is not set.
    try {
        const { indexOpenDialogMarkers } = await import("@genesiscz/utils/agents/dialogs/store");
        indexOpenDialogMarkers();
    } catch (err) {
        hookDiag("The one-time open-marker pass failed; older open records stay unmarked", { err });
        process.exit(0);
    }

    if (!hasOpenDialogRecords(payload.harness, payload.sessionId)) {
        process.exit(0);
    }
}

try {
    const { applyQuestionHookAction, questionHookAction } = await import("../lib/hooks/questions");
    const now = new Date().toISOString();
    const action = questionHookAction(payload, now);

    if (action) {
        const result = await applyQuestionHookAction(payload, action, { now });

        if (result.recorded || result.closed.length > 0) {
            logDecision(
                {
                    at: now,
                    phase: "question",
                    harness: payload.harness,
                    session: payload.sessionId,
                    toolUseId: payload.toolUseId,
                    decision: result.recorded ? "recorded" : "closed",
                    reason: `${payload.event}${payload.tool ? ` ${payload.tool}` : ""}`,
                    ...(result.recorded ? { recorded: result.recorded } : {}),
                    ...(result.closed.length > 0 ? { closed: result.closed } : {}),
                },
                config.logPath
            );
        }
    }
} catch (err) {
    // A hook that throws blocks the tool call or the prompt; the question is then simply not recorded.
    hookDiag("The question hook failed; the dialog record was not written", { err, event: payload.event });
}
