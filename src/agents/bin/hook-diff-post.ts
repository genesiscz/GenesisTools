#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { fileToolSource } from "../lib/changes/log";
import { diffFor, loadHooksConfig, megabytes } from "../lib/hooks/config";
import { flushDeferred, noteFileToolInput, recordFileToolChange, runDiffPost } from "../lib/hooks/diff/run";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, normalizeEvent, parseHookPayload } from "../lib/hooks/payload";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const payload = parseHookPayload(await Bun.stdin.text());

// PostToolUseFailure is a Bash call that failed: its edits are as real as a successful one's.
if (!payload || !["posttooluse", "posttoolusefailure"].includes(normalizeEvent(payload.event))) {
    process.exit(0);
}

// Edit and Write render their own diff; they only need a row in the session change log, and
// their file in this session's mention index and the cross-session touches ledger.
if (fileToolSource(payload.tool)) {
    noteFileToolInput(payload);
    recordFileToolChange(payload);
    process.exit(0);
}

if (!isTerminalTool(payload.tool)) {
    process.exit(0);
}

// A background call deferred its diff to the end of its task (`flushDeferred`); the ones that have
// ended since print first, in at most half of the one message, and this call gets the rest.
const maxChars = diffFor(config, payload.harness).maxMessageChars;
const flushed = flushDeferred({ payload, config, maxChars: Math.floor(maxChars / 2) });
const flushedParts = flushed
    .filter((item) => item.message && item.task)
    .map(
        (item) =>
            `background task ${item.task?.id} ended (${item.task?.command.split("\n")[0]?.slice(0, 80)}):\n${item.message}`
    );
const flushedChars = flushedParts.reduce((total, part) => total + part.length + 2, 0);
const decision = runDiffPost({ payload, config, maxChars: Math.max(0, maxChars - flushedChars) });

for (const item of [...flushed, decision]) {
    logDecision(
        {
            at: new Date().toISOString(),
            phase: "post",
            harness: payload.harness,
            session: payload.sessionId,
            toolUseId: item.task?.toolUseId ?? payload.toolUseId,
            decision: item.decision,
            reason: item.reason,
            files: item.files,
            ...(item.others && item.others.length > 0 ? { others: item.others } : {}),
            ...(item.attributed ? { attributed: item.attributed } : {}),
            ...(item.stats ? item.stats : {}),
            ...(item.task ? { background: item.task.id, flushedBy: payload.toolUseId } : {}),
        },
        config.logPath
    );
}

const message = [...flushedParts, ...(decision.message ? [decision.message] : [])].join("\n\n");

if (message && !config.shadow) {
    // systemMessage is the only field the USER sees; additionalContext is model-only.
    process.stdout.write(SafeJSON.stringify({ systemMessage: message }));
}
