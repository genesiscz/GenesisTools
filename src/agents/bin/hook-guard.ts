#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { keepsCommand, loadHooksConfig, megabytes } from "../lib/hooks/config";
import { guardRules, logCustomRuleProblems } from "../lib/hooks/custom-rules";
import { evaluateGuard } from "../lib/hooks/guard";
import { settleGuardVerdict } from "../lib/hooks/guard-metrics";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, parseHookPayload } from "../lib/hooks/payload";

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

const shown = await settleGuardVerdict({ payload, verdict, config });

if (!shown) {
    process.exit(0);
}

if (shown.outcome === "block") {
    process.stdout.write(
        SafeJSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: shown.message,
            },
        })
    );
    process.exit(0);
}

// `systemMessage` is the only field the USER sees; `additionalContext` is model-only.
process.stdout.write(
    SafeJSON.stringify({
        ...(shown.outcome === "warn" ? { systemMessage: shown.userMessage } : {}),
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: shown.message },
    })
);
