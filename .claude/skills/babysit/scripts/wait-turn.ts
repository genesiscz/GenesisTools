#!/usr/bin/env bun
/**
 * Wait for a Codex worker's current turn to end (run it with Bash run_in_background: the harness wakes the lead when
 * it exits), save the `tools codex wait --json` result, and log the worker's final message to the run ledger.
 *
 *   bun wait-turn.ts --run <dir> --worker <name> --thread <id> [--pr N] [--round N] [--model m] [--timeout 3600]
 *   bun wait-turn.ts --run <dir> --worker <name> --from-file <wait.json> …   (log a result saved earlier)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { appendEvent, readEvents } from "./ledger";
import { flag, loadRun } from "./run";

const run = loadRun();
const worker = flag("--worker") ?? "";
const pr = flag("--pr");
const round = flag("--round");
const fromFile = flag("--from-file");
let raw = "";
let exitCode = 0;
let stderr = "";

if (fromFile) {
    raw = readFileSync(fromFile, "utf8");
} else {
    const timeoutSeconds = Number(flag("--timeout") ?? 3600);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        console.error("--timeout must be a positive finite number of seconds");
        process.exit(2);
    }

    const steer = readEvents(run.dir).findLast(
        (event) =>
            event.kind === "steer" &&
            event.worker === worker &&
            (pr === undefined || event.pr === Number(pr)) &&
            (round === undefined || event.round === Number(round))
    );
    const fence = steer?.meta;
    const finite = (value: unknown): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (
        !fence ||
        !finite(fence.sentAt) ||
        (fence.baselineTurnStartedAt !== undefined && !finite(fence.baselineTurnStartedAt)) ||
        (fence.baselineTranscriptBytes !== undefined && !finite(fence.baselineTranscriptBytes))
    ) {
        console.error("no answering-turn fence: use steer.ts before waiting, or import a saved --from-file report");
        process.exit(2);
    }
    const thread = flag("--thread");
    if (
        fence.sessionId !== undefined &&
        (typeof fence.sessionId !== "string" || (thread && thread !== fence.sessionId))
    ) {
        console.error("--thread differs from the pre-steer session baseline");
        process.exit(2);
    }
    try {
        const p = Bun.spawnSync(
            [
                toolsEntrypoint(),
                "codex",
                "wait",
                thread ?? (typeof fence.sessionId === "string" ? fence.sessionId : worker),
                "--next",
                "--sent-at",
                String(fence.sentAt),
                ...(fence.baselineTurnStartedAt !== undefined
                    ? ["--baseline-turn-started-at", String(fence.baselineTurnStartedAt)]
                    : []),
                ...(fence.baselineTranscriptBytes !== undefined
                    ? ["--baseline-transcript-bytes", String(fence.baselineTranscriptBytes)]
                    : []),
                "--stall-timeout",
                "1800",
                "--timeout",
                String(timeoutSeconds),
                "--json",
            ],
            {
                cwd: run.main,
                stdout: "pipe",
                stderr: "pipe",
                env: env.getProcessEnv(),
                timeout: (timeoutSeconds + 30) * 1000,
            }
        );
        raw = p.stdout.toString();
        exitCode = p.signalCode ? 124 : (p.exitCode ?? 1);
        stderr = p.stderr.toString();
        if (p.signalCode) {
            raw = SafeJSON.stringify({ outcome: "timeout", error: "wait supervisor deadline expired" });
        }
    } catch (error) {
        exitCode = 1;
        raw = SafeJSON.stringify({ outcome: "error", error: String(error) });
    }
}

const logs = join(run.dir, "logs");
mkdirSync(logs, { recursive: true });
const file = fromFile ?? join(logs, `wait-${worker}-${pr}r${round}-${Date.now()}.json`);

if (!fromFile) {
    writeFileSync(file, raw);
}

let text = "";
let failure: string | null = null;
let meta: Record<string, unknown> = { exit: exitCode, file };

try {
    const value: unknown = SafeJSON.parse(raw, { strict: true });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("wait report must be an object");
    }
    const result = value as Record<string, unknown>;
    if (
        (result.error != null && typeof result.error !== "string") ||
        (result.lastText !== undefined && typeof result.lastText !== "string")
    ) {
        throw new Error("wait report error and lastText must be strings when present");
    }
    text = typeof result.lastText === "string" ? result.lastText : "";
    failure = typeof result.error === "string" ? result.error : null;
    if (fromFile) {
        if (result.outcome !== "done" && result.outcome !== "stalled" && result.outcome !== "timeout") {
            throw new Error("saved wait report has no valid outcome");
        }
        // Match codex wait: timeout/stall take precedence, and a failed completed turn exits 4.
        exitCode = result.outcome === "timeout" ? 124 : result.outcome === "stalled" ? 3 : failure ? 4 : 0;
    } else if (failure && exitCode === 0) {
        exitCode = 4;
    }
    meta = {
        ...meta,
        exit: exitCode,
        outcome: result.outcome,
        state: result.state,
        ...(failure ? { error: failure } : {}),
    };
} catch (error) {
    exitCode = exitCode || 1;
    failure = "invalid wait report: " + (error instanceof Error ? error.message : String(error));
    text = "(invalid wait report) " + stderr.slice(0, 500);
    meta = { ...meta, exit: exitCode, outcome: "error", error: failure };
}

appendEvent(run.dir, {
    kind: "turn",
    worker,
    model: flag("--model"),
    ...(pr ? { pr: Number(pr) } : {}),
    ...(round ? { round: Number(round) } : {}),
    text,
    meta,
});
const result = text.match(/RESULT:\s*(.+)/)?.[1] ?? "";

if (failure) {
    console.log(`✖ ${worker} #${pr} r${round} turn FAILED (exit ${exitCode}): ${failure} → ${file}`);
    console.log("  inspect the wait report before retrying the steer or moving the brief to another worker");
} else {
    console.log(`${worker} #${pr} r${round} turn ended exit=${exitCode} ${result.slice(0, 120)} → ${file}`);
}

// Imported waits use the validated result status; live waits retain the supervising process status.
process.exitCode = exitCode;
