#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { fileToolSource } from "../lib/changes/log";
import { loadHooksConfig, megabytes } from "../lib/hooks/config";
import { recordFileToolChange, runDiffPost } from "../lib/hooks/diff/run";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, normalizeEvent, parseHookPayload } from "../lib/hooks/payload";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload || normalizeEvent(payload.event) !== "posttooluse") {
    process.exit(0);
}

// Edit and Write render their own diff; they only need a row in the session change log.
if (fileToolSource(payload.tool)) {
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
    },
    config.logPath
);

if (decision.message && !config.shadow) {
    // systemMessage is the only field the USER sees; additionalContext is model-only.
    process.stdout.write(SafeJSON.stringify({ systemMessage: decision.message }));
}
