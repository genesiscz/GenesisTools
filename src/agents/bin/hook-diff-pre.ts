#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { loadHooksConfig } from "../lib/hooks/config";
import { capturePre } from "../lib/hooks/diff/capture";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, normalizeEvent, parseHookPayload } from "../lib/hooks/payload";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(config.maxLogBytes);

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload || normalizeEvent(payload.event) !== "pretooluse" || !isTerminalTool(payload.tool)) {
    process.exit(0);
}

if (!config.diff.enabled) {
    process.exit(0);
}

const result = capturePre(payload, config.diff);

logDecision(
    {
        at: new Date().toISOString(),
        phase: "pre",
        harness: payload.harness,
        session: payload.sessionId,
        toolUseId: payload.toolUseId,
        decision: "stamped",
        reason: "captured the before state of dirty files",
        roots: result.roots,
        captured: result.captured,
        skipped: result.skipped,
    },
    config.logPath
);
