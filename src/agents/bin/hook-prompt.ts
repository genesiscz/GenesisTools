#!/usr/bin/env bun
import { decisionFiles } from "@app/question/lib/decisions/read";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { loadHooksConfig, megabytes } from "../lib/hooks/config";
import { runDecisionInject } from "../lib/hooks/decisions";
import { hookDiag, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { normalizeEvent, parseHookPayload } from "../lib/hooks/payload";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload || normalizeEvent(payload.event) !== "userpromptsubmit") {
    process.exit(0);
}

/** Resolves once stdout took the bytes, so a failed write puts the answers back instead of losing them. */
function writeStdout(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
    });
}

try {
    await runDecisionInject(payload, config.decisions, {
        log: decisionFiles(),
        emit: (output) => writeStdout(SafeJSON.stringify(output)),
    });
} catch (err) {
    // A prompt hook that throws blocks the user's prompt; the answers stay queued instead.
    hookDiag("The decision prompt hook failed; the answers stay queued", { err });
}
