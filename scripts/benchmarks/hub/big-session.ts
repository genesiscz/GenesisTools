#!/usr/bin/env bun
/**
 * What a very large session costs the hub: the calls the hub sends when the session is selected (the transcript's last
 * page, its sub-agents, the Changes pane, its decisions, the agents list, the usage rows), answered through the
 * resident server's doors in one process. The session is the largest Claude transcript on this Mac unless
 * `--session <id>` names one (749 MB with 151 sub-agents on 2026-11-10, when a selection of it left the transcript
 * pane with "tools call exceeded 30s").
 *
 * The metrics that matter: `*.stallMs` and `together.maxStallMs` (the longest time the server's event loop answered
 * nobody: every other call of every window waits that long), `together.tailAnswerMs` (how long the cheapest call
 * waits behind the others), `*.cpuMs`, and the peak memory. Wall time follows the Mac's load; read it beside
 * `loadAvg`.
 *
 * ARMS, interleaved per run, each a fresh process (`big-session-child.ts`): `current` is this checkout; `--before
 * <checkout>` adds a second checkout (a worktree at an older commit) whose own code runs. `*.bytes` is the check:
 * both arms must give answers of the same size (the live session may grow between runs, so a difference is printed,
 * not thrown).
 *
 * Usage:
 *   bun scripts/benchmarks/hub/big-session.ts --runs 5 [--session <id>] [--before <checkout>]
 *   bun scripts/benchmarks/hub/big-session.ts --baseline | --compare
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import { finishBench, parseBenchArgs, stringFlag } from "../fs/shared";

const BASELINE_NAME = "hub-big-session";
const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(import.meta.dir, "big-session-child.ts");
const argv = process.argv.slice(2);
/** Keep the five-run default. The changes acceptance run uses three interleaved samples. */
const args = parseBenchArgs(argv, { runs: { fallback: 5, minimum: 3 } });

/** The largest main transcript under the Claude session roots: `<root>/<project>/<session id>.jsonl`. */
function largestClaudeSession(): { id: string; bytes: number } | null {
    let best: { id: string; bytes: number } | null = null;

    for (const root of nativeSessionRoots("claude")) {
        let projects: string[];
        try {
            projects = readdirSync(root);
        } catch (error) {
            out.log.warn(`${root}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        for (const project of projects) {
            let files: string[];
            try {
                files = readdirSync(join(root, project)).filter((file) => file.endsWith(".jsonl"));
            } catch (error) {
                // A file beside the project folders is not a project; any other failure hides a transcript.
                if (!(error instanceof Error && "code" in error && error.code === "ENOTDIR")) {
                    out.log.warn(
                        `${join(root, project)}: ${error instanceof Error ? error.message : String(error)}; its transcripts are not counted`
                    );
                }

                continue;
            }

            for (const file of files) {
                const bytes = statSync(join(root, project, file)).size;
                if (!best || bytes > best.bytes) {
                    best = { id: basename(file, ".jsonl"), bytes };
                }
            }
        }
    }

    return best;
}

const named = stringFlag(argv, "--session");
const largest = named ? null : largestClaudeSession();
const session = named ?? largest?.id;

if (!session) {
    throw new Error("no Claude transcript found; pass --session <id>");
}

const beforeFlag = stringFlag(argv, "--before");
/** The child imports this path from its own folder, so a relative `--before` is made absolute against the repo root. */
const before = beforeFlag ? resolve(REPO, beforeFlag) : undefined;
const arms: Array<{ name: string; checkout: string }> = [
    { name: "current", checkout: REPO },
    ...(before ? [{ name: "before", checkout: before }] : []),
];

/**
 * One sample's deadline: twelve calls of the largest session (749 MB) took under two minutes on 2026-11-10, so a child
 * still running after 15 minutes is stuck; it is killed with its process group and the run fails, naming the arm.
 */
const SAMPLE_DEADLINE_MS = 15 * 60_000;

async function sample(checkout: string, mode: "each" | "together" | "changes") {
    const result = await boundedCommand({
        command: [process.execPath, "run", CHILD, checkout, session as string, mode],
        timeoutMs: SAMPLE_DEADLINE_MS,
        environment:
            mode === "changes"
                ? { ...env.getProcessEnv(), PROFILE: "session-changes", PROFILE_TO_STDERR: "1" }
                : undefined,
        cwd: REPO,
    });

    if (result.error?.code === "ETIMEDOUT") {
        throw new Error(
            `big-session-child ${mode} for ${checkout} passed its ${SAMPLE_DEADLINE_MS / 60_000}-minute deadline and was killed: ${result.stderr.trim().slice(-600)}`
        );
    }

    if (result.error || result.status !== 0) {
        throw new Error(
            `big-session-child ${mode} failed (${result.error?.message ?? `exit ${result.status}`}) for ${checkout}: ${result.stderr.trim().slice(-600)}`
        );
    }

    const output: Record<string, unknown> = SafeJSON.parse(result.stdout.trim().split("\n").pop() ?? "{}", {
        strict: true,
    });
    const metrics: Record<string, number> = {};
    for (const [key, value] of Object.entries(output)) {
        if (typeof value === "number") {
            metrics[key] = value;
        }
    }
    const digest = output["changes.digest"];
    if (mode === "changes" && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
        throw new Error(`missing Changes digest for ${checkout}`);
    }
    if (mode === "changes") {
        const cold = result.stderr.split("changes-cold-finished")[0];
        const phases = [...cold.matchAll(/\[profile:session-changes\] facts cpu=(\d+)ms/g)];
        if (phases.length) {
            metrics["changes.cold.factsCpuMs"] = phases.reduce((sum, match) => sum + Number(match[1]), 0);
        }
    }
    return { metrics, digest: typeof digest === "string" ? digest : undefined };
}

const runs: Array<Record<string, number>> = [];

for (let run = 0; run < args.warmup + args.runs; run++) {
    const merged: Record<string, number> = {};

    const digests = new Map<string, string>();
    for (const arm of run % 2 === 0 ? arms : [...arms].reverse()) {
        for (const mode of ["each", "together", "changes"] as const) {
            const result = await sample(arm.checkout, mode);
            if (result.digest) {
                digests.set(arm.name, result.digest);
                out.log.info(`run ${run + 1} ${arm.name} changes.digest ${result.digest}`);
            }
            for (const [key, value] of Object.entries(result.metrics)) {
                const name = mode === "each" && key.startsWith("changes.") ? `each.${key}` : key;
                merged[`${arm.name}.${name}`] = value;
            }
        }
    }

    if (before && digests.get("current") !== digests.get("before")) {
        throw new Error(
            `Changes stdout differs in run ${run + 1}: current ${digests.get("current")}, before ${digests.get("before")}`
        );
    }
    if (run >= args.warmup) {
        runs.push(merged);
    }
}

if (before) {
    for (const key of Object.keys(runs[0] ?? {}).filter(
        (name) => name.startsWith("current.") && name.endsWith(".bytes")
    )) {
        const other = key.replace("current.", "before.");
        if (runs[0][key] !== runs[0][other]) {
            out.log.warn(
                `${key} = ${runs[0][key]} but ${other} = ${runs[0][other]}: the arms did not give the same answer`
            );
        }
    }
}

const timed = (key: string) => key.endsWith("Ms") || key.endsWith("Mb");

await finishBench({
    name: BASELINE_NAME,
    title: `The hub's calls for one very large session, through the server's doors (session ${session.slice(0, 8)})`,
    args,
    runs,
    lowerIsBetter: Object.keys(runs[0] ?? {}).filter((key) => timed(key) || key.endsWith(".failed")),
    // Under 50 ms a stall or a call is noise on a busy Mac; memory moves by tens of MB between runs.
    floor: Object.fromEntries(Object.keys(runs[0] ?? {}).map((key) => [key, timed(key) ? 50 : 0])),
    notes: `session ${session}${largest ? ` (the largest Claude transcript, ${Math.round(largest.bytes / 1024 / 1024)} MB)` : ""}, live files, read-only${before ? `; before = ${before}` : ""}`,
    context: { arms, session },
});
