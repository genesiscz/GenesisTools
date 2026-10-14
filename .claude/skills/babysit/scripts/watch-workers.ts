#!/usr/bin/env bun
/**
 * Monitor feed for babysit: one line per turn start and end, tool call, failed tool, approval, question, error and
 * stall, for every worker named as grok:<name> or codex:<name>. Read-only.
 *
 * Codex goes through `tools codex tail --follow --tail 0 --events` (one session-long stream). Not `--format`: that
 * path ignores `--tail` and stops at the end of a turn, so a restart replayed the whole history (2026-10-14).
 * Grok has one stream per turn: the script polls `tools grok status` and tails each running turn.
 *
 * Usage: bun .claude/skills/babysit/scripts/watch-workers.ts grok:bs-512-grok codex:bs-511-sol [--stall-s 180] [--run <dir>]
 *
 * With --run, each line also names the PR and round the worker was last steered to (from the run's ledger): a worker
 * keeps its first PR's name across later PRs, so "bs-compress turn 13" read as the compress PR taking 13 turns when
 * it was #516 round 3 (2026-10-14).
 */
import { execTool } from "@genesiscz/utils/cli";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { SafeJSON } from "@genesiscz/utils/json";
import { readEvents } from "./ledger";
import { flag } from "./run";

const args = process.argv.slice(2);
const stallIndex = args.indexOf("--stall-s");
const STALL_MS = (stallIndex >= 0 ? Number(args[stallIndex + 1]) : 180) * 1000;
const workers = args
    .filter((arg) => /^(grok|codex):/.test(arg))
    .map((spec) => {
        const [backend, name] = spec.split(":") as ["grok" | "codex", string];
        return { backend, name, label: `${backend}:${name}`, lastAt: Date.now(), running: false, stallSaid: false };
    });
type Worker = (typeof workers)[number];

const runDir = flag("--run");

/** ` #516 r3` for the worker's latest steer or spawn in the ledger; empty without --run or a match. */
function currentTask(name: string): string {
    if (!runDir) {
        return "";
    }

    const last = readEvents(runDir).findLast(
        (event) => event.worker === name && (event.kind === "steer" || event.kind === "spawn")
    );
    return last?.pr ? ` #${last.pr}${last.round ? ` r${last.round}` : ""}` : "";
}

const say = (w: Worker, text: string) =>
    console.log(`[${w.label}${currentTask(w.name)}] ${text.replace(/\s+/g, " ").slice(0, 220)}`);
const MARKERS = /^(▶|✔|✖|⏸|■|⚠|🛑|❓)/u;

export async function pump(w: Worker, cmd: string[], timeoutMs = 1_800_000): Promise<number> {
    const child = Bun.spawn(cmd, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", detached: true });
    let expired = false;
    const timer = setTimeout(() => {
        expired = true;
        try {
            // pid-verified: this is the retained child's own process group.
            process.kill(-child.pid, "SIGKILL");
        } catch (error) {
            say(w, "deadline signal failed: " + String(error));
        }
    }, timeoutMs);
    const stderr = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr) {
            say(w, "stderr: " + decoder.decode(chunk, { stream: true }));
        }
    })();
    try {
        const decoder = new TextDecoder();
        let buf = "";

        for await (const chunk of child.stdout) {
            buf += decoder.decode(chunk, { stream: true });
            let nl = buf.indexOf("\n");

            while (nl >= 0) {
                const line = buf.slice(0, nl).trimEnd();
                buf = buf.slice(nl + 1);
                nl = buf.indexOf("\n");

                if (!line.trim()) {
                    continue;
                }

                w.lastAt = Date.now();
                w.stallSaid = false;

                if (line.startsWith("🔧")) {
                    say(w, `tool ${line.slice(2).trim()}`);
                } else if (line.startsWith("↩") && line.includes("FAILED")) {
                    say(w, line);
                } else if (MARKERS.test(line)) {
                    say(w, line);
                } else if (line.startsWith("💬") && /\?\s*$/.test(line)) {
                    say(w, `QUESTION ${line.slice(2).trim()}`);
                }
            }
        }

        await stderr;
        const code = await child.exited;
        return expired ? 124 : code;
    } finally {
        clearTimeout(timer);
    }
}

async function grokStatus(w: Worker): Promise<{ running: boolean; turns: number; exitCode?: number } | null> {
    const result = await execTool(["grok", "status", "--name", w.name, "--json"], {
        cwd: process.cwd(),
        timeout: 30_000,
    });

    if (!result.success) {
        say(w, "status failed: " + result.stderr);
        return null;
    }

    try {
        const meta = SafeJSON.parse(result.stdout.toString(), { strict: true });
        return { running: Boolean(meta.running), turns: meta.turns ?? 0, exitCode: meta.lastTurn?.exitCode };
    } catch {
        return null;
    }
}

async function watchGrok(w: Worker): Promise<void> {
    for (;;) {
        const status = await grokStatus(w);

        if (status?.running) {
            w.running = true;
            say(w, `turn ${status.turns} RUNNING`);
            await pump(w, [
                process.execPath,
                "run",
                toolsEntrypoint(),
                "grok",
                "tail",
                "--name",
                w.name,
                "--format",
                "events",
                "--thoughts",
                "none",
            ]);
            const end = await grokStatus(w);
            say(w, `turn ${end?.turns ?? "?"} ENDED exit=${end?.exitCode ?? "?"}`);
            w.running = false;
        }

        await Bun.sleep(3000);
    }
}

async function watchCodex(w: Worker): Promise<void> {
    w.running = true;
    const code = await pump(w, [
        process.execPath,
        "run",
        toolsEntrypoint(),
        "codex",
        "tail",
        "--name",
        w.name,
        "--follow",
        "--tail",
        "0",
        "--events",
    ]);
    w.running = false;
    say(w, `session closed (tail exit ${code})`);
}

if (import.meta.main) {
    const stallTimer = setInterval(() => {
        for (const w of workers) {
            if (w.running && !w.stallSaid && Date.now() - w.lastAt > STALL_MS) {
                say(w, `STALL: no event for ${Math.round((Date.now() - w.lastAt) / 1000)} s`);
                w.stallSaid = true;
            }
        }
    }, 15_000);

    console.log(`watching ${workers.map((w) => w.label).join(", ")}`);
    await Promise.all(workers.map((w) => (w.backend === "grok" ? watchGrok(w) : watchCodex(w))));
    clearInterval(stallTimer);
}
