#!/usr/bin/env bun
import { decisionFiles } from "@app/question/lib/decisions/read";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { loadHooksConfig, megabytes } from "../lib/hooks/config";
import { runDecisionStop } from "../lib/hooks/decisions";
import { hookDiag, logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { normalizeEvent, parseHookPayload } from "../lib/hooks/payload";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload || normalizeEvent(payload.event) !== "stop") {
    process.exit(0);
}

try {
    const output = await runDecisionStop(payload, config.decisions, { log: decisionFiles() });

    if (output) {
        logDecision(
            {
                at: new Date().toISOString(),
                phase: "stop",
                harness: payload.harness,
                session: payload.sessionId,
                decision: "decision" in output ? "block" : "warn",
                reason: "decision" in output ? output.reason : output.systemMessage,
            },
            config.logPath
        );
        process.stdout.write(SafeJSON.stringify(output));
    }
} catch (err) {
    // A Stop hook that throws would hold the turn open; the decision check is never worth that.
    hookDiag("The decision Stop hook failed; the turn ends normally", { err });
}
