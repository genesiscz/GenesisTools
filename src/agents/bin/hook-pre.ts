#!/usr/bin/env bun
/**
 * The whole PreToolUse phase in ONE process: the guard verdict, then the before-state
 * capture. Measured 2026-09-20: two separate entrypoints cost 18.9 ms + 75.6 ms, and a bun
 * start plus this import graph is about 10 ms of that, paid twice for no reason.
 *
 * Order is load-bearing. The guard runs FIRST, and a denied command skips the capture
 * entirely: the command will not run, so there is nothing to diff, and capturing anyway is
 * what leaves an orphaned capture under /tmp for the collector to find later.
 */
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { keepsCommand, loadHooksConfig, megabytes } from "../lib/hooks/config";
import { capturePre } from "../lib/hooks/diff/capture";
import { evaluateGuard } from "../lib/hooks/guard";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, normalizeEvent, parseHookPayload } from "../lib/hooks/payload";
import { bumpContextCounts, safeSessionId } from "../lib/hooks/state";

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

const at = new Date().toISOString();
const verdict = evaluateGuard(payload, config);

logDecision(
    {
        at,
        phase: "guard",
        harness: payload.harness,
        session: payload.sessionId,
        toolUseId: payload.toolUseId,
        decision: verdict?.outcome ?? "allow",
        reason: verdict ? verdict.tags.join(",") : "no rule matched",
        demoted: verdict?.demoted ?? [],
        shadow: config.shadow,
        // The command is what makes a shadow run replayable against the guard this replaces,
        // and it is also whatever the user typed, inline secrets included. `logCommands`
        // decides; the default records it only while shadowed.
        ...(keepsCommand(config) ? { command: payload.command } : {}),
    },
    config.logPath
);

const denied = verdict?.outcome === "block" && !config.shadow;

if (!denied && config.diff.enabled) {
    const capture = capturePre(payload, config.diff);

    logDecision(
        {
            at,
            phase: "pre",
            harness: payload.harness,
            session: payload.sessionId,
            toolUseId: payload.toolUseId,
            decision: capture.roots.length > 0 || capture.named > 0 ? "stamped" : "skip",
            reason:
                capture.roots.length > 0 || capture.named > 0
                    ? "captured the before state of dirty files"
                    : "no git repository and no named path to capture",
            roots: capture.roots,
            captured: capture.captured,
            named: capture.named,
            skipped: capture.skipped,
        },
        config.logPath
    );
}

if (!verdict || config.shadow) {
    // Shadowed: it decided, it logged, and it says nothing. That pair is the point. The
    // context counters stay untouched, because a note nobody saw must not count towards the
    // per-session cap the moment shadow is switched off.
    process.exit(0);
}

const sessionId = safeSessionId(payload.sessionId);

if (sessionId && verdict.shownContextRules.length > 0) {
    bumpContextCounts(sessionId, verdict.shownContextRules);
}

if (verdict.outcome === "block") {
    process.stdout.write(
        SafeJSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: verdict.message,
            },
        })
    );
    process.exit(0);
}

// `systemMessage` is the only field the USER sees; `additionalContext` is model-only.
process.stdout.write(
    SafeJSON.stringify({
        ...(verdict.outcome === "warn" ? { systemMessage: verdict.message } : {}),
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: verdict.message },
    })
);
