#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { keepsCommand, loadHooksConfig, megabytes } from "../lib/hooks/config";
import { guardRules, logCustomRuleProblems } from "../lib/hooks/custom-rules";
import { evaluateGuard, guardLoop } from "../lib/hooks/guard";
import { recordGuardVerdict } from "../lib/hooks/guard-metrics";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, parseHookPayload } from "../lib/hooks/payload";
import { recordGuardShown, safeSessionId } from "../lib/hooks/state";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload) {
    process.exit(0);
}

// Only a shell call can trip a rule, so only a shell call pays for importing the custom ones.
const { rules, custom } = isTerminalTool(payload.tool) ? await guardRules(config) : { rules: undefined, custom: null };

logCustomRuleProblems(custom);

const verdict = evaluateGuard(payload, config, rules);

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

recordGuardVerdict({ payload, verdict, config });

if (!verdict || verdict.outcome === "allow") {
    process.exit(0);
}

if (config.shadow) {
    // Shadowed: it decided, it logged, and it says nothing. That pair is the point.
    // The context counters stay untouched, because a note nobody saw must not count
    // towards the per-session cap the moment shadow is switched off.
    process.exit(0);
}

const sessionId = safeSessionId(payload.sessionId);

if (sessionId && verdict.seenRules.length > 0) {
    await recordGuardShown(sessionId, {
        contextRules: verdict.shownContextRules,
        loop: guardLoop(payload),
        explainedRules: verdict.explainedRules,
        seenRules: verdict.seenRules,
        at: Date.now(),
    });
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
        ...(verdict.outcome === "warn" ? { systemMessage: verdict.userMessage } : {}),
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: verdict.message },
    })
);
