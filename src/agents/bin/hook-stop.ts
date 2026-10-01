#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { decisionHooksWanted, loadHooksConfig, megabytes } from "../lib/hooks/config";
import { readSessionState } from "../lib/hooks/diff/mentions";
import { gitOut } from "../lib/hooks/git";
import { hookDiag, logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { safeSegment } from "../lib/hooks/paths";
import { normalizeEvent, parseHookPayload } from "../lib/hooks/payload";
import { unpushedReminders } from "../lib/hooks/unpushed";

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

let output: { decision?: "block"; reason?: string; systemMessage?: string } | null = null;

// The decision hub's module graph is loaded only when one of its hooks is on: this entrypoint
// now runs at the end of every turn for the unpushed reminder alone.
if (decisionHooksWanted(config)) {
    try {
        const { decisionFiles } = await import("@app/question/lib/decisions/read");
        const { runDecisionStop } = await import("../lib/hooks/decisions");

        const decided = await runDecisionStop(payload, config.decisions, { log: decisionFiles() });

        if (decided) {
            logDecision(
                {
                    at: new Date().toISOString(),
                    phase: "stop",
                    harness: payload.harness,
                    session: payload.sessionId,
                    decision: "decision" in decided ? "block" : "warn",
                    reason: "decision" in decided ? decided.reason : decided.systemMessage,
                },
                config.logPath
            );
            output = decided;
        }
    } catch (err) {
        // A Stop hook that throws would hold the turn open; the decision check is never worth that.
        hookDiag("The decision Stop hook failed; the turn ends normally", { err });
    }
}

try {
    const session = safeSegment(payload.sessionId);
    const roots = new Set(session ? (readSessionState(session).roots ?? []) : []);

    // The session's own repository counts too, so the reminder still works when diff capture (which
    // records the other roots) is off, as it is for Grok by default.
    if (config.unpushed.enabled) {
        const own = gitOut(payload.cwd, ["rev-parse", "--show-toplevel"], { quiet: true }).trim();

        if (own) {
            roots.add(own);
        }
    }

    const reminders = unpushedReminders([...roots], config.unpushed);

    if (reminders.length > 0) {
        logDecision(
            {
                at: new Date().toISOString(),
                phase: "stop",
                harness: payload.harness,
                session: payload.sessionId,
                decision: "warn",
                reason: reminders.join(" | "),
            },
            config.logPath
        );

        const message = [output?.systemMessage, ...reminders].filter(Boolean).join("\n");

        output = { ...(output ?? {}), systemMessage: message };
    }
} catch (err) {
    hookDiag("The unpushed Stop check failed; the turn ends normally", { err });
}

if (output) {
    process.stdout.write(SafeJSON.stringify(output));
}
