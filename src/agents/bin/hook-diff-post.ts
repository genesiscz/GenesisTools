#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { fileToolSource } from "../lib/changes/log";
import { loadHooksConfig, megabytes } from "../lib/hooks/config";
import { noteFileToolInput, recordFileToolChange, runDiffPost } from "../lib/hooks/diff/run";
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

const decision = runDiffPost(payload, config);

logDecision(
    {
        at: new Date().toISOString(),
        phase: "post",
        harness: payload.harness,
        session: payload.sessionId,
        toolUseId: payload.toolUseId,
        decision: decision.decision,
        reason: decision.reason,
        files: decision.files,
        ...(decision.others && decision.others.length > 0 ? { others: decision.others } : {}),
        ...(decision.stats ? decision.stats : {}),
    },
    config.logPath
);

if (decision.message && !config.shadow) {
    // systemMessage is the only field the USER sees; additionalContext is model-only.
    process.stdout.write(SafeJSON.stringify({ systemMessage: decision.message }));
}
