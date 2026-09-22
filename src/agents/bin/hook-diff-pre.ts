#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { diffFor, loadHooksConfig, megabytes } from "../lib/hooks/config";
import { capturePre } from "../lib/hooks/diff/capture";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, normalizeEvent, parseHookPayload } from "../lib/hooks/payload";

if (env.isFlag("AGENTS_HOOKS_DISABLE")) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload || normalizeEvent(payload.event) !== "pretooluse" || !isTerminalTool(payload.tool)) {
    process.exit(0);
}

// Resolved per harness, so a harness that cannot SHOW a diff never pays for the capture
// either: no `git status`, no tar, no copies, nothing to sweep in the post phase.
const diff = diffFor(config, payload.harness);

if (!diff.enabled) {
    process.exit(0);
}

const result = capturePre(payload, diff);

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
        named: result.named,
        skipped: result.skipped,
    },
    config.logPath
);
