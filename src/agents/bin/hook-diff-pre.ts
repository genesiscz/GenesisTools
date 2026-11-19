#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { diffFor, loadHooksConfig, megabytes } from "../lib/hooks/config";
import { capturePre, captureStart } from "../lib/hooks/diff/capture";
import { gitReads, prepareStatus, type StatusCall, statusEligible } from "../lib/hooks/diff/status/prepare";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, normalizeEvent, parseHookPayload } from "../lib/hooks/payload";

if (env.agents.areHooksDisabled()) {
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

// The status reads come first and may be async (an RPC, a shadow run); the capture itself stays synchronous.
const start = captureStart(payload, diff);
const statusCall: StatusCall = {
    harness: payload.harness,
    sessionId: payload.sessionId ?? "",
    toolUseId: payload.toolUseId ?? "",
    command: payload.command,
    dir: payload.cwd,
};
const need = start.readOnly ? "deletions" : "all";
const status = statusEligible(statusCall, { background: false, deferred: false })
    ? await prepareStatus({ phase: "pre", roots: start.roots, need, call: statusCall, config: diff.status })
    : gitReads(need);
const result = capturePre(payload, diff, { start, status });

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
