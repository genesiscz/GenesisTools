#!/usr/bin/env bun
import { SafeJSON } from "@genesiscz/utils/json";
import { keepsCommand, loadHooksConfig } from "../lib/hooks/config";
import { evaluateGuard } from "../lib/hooks/guard";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { parseHookPayload } from "../lib/hooks/payload";
import { bumpContextCounts, safeSessionId } from "../lib/hooks/state";

if (process.env.AGENTS_HOOKS_DISABLE === "1") {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(config.maxLogBytes);

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload) {
    process.exit(0);
}

const verdict = evaluateGuard(payload, config);

logDecision(
    {
        at: new Date().toISOString(),
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

if (!verdict) {
    process.exit(0);
}

if (config.shadow) {
    // Shadowed: it decided, it logged, and it says nothing. That pair is the point.
    // The context counters stay untouched, because a note nobody saw must not count
    // towards the per-session cap the moment shadow is switched off.
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
