#!/usr/bin/env bun
/**
 * Monitor feed for babysit: one line per turn start and end, tool call, failed tool, approval, question, error and
 * stall, for every worker named as grok:<name> or codex:<name>. Read-only.
 *
 * Codex goes through `tools codex tail --follow --tail 0 --events` (one session-long stream). Not `--format`: that
 * path ignores `--tail` and stops at the end of a turn, so a restart replayed the whole history (2026-10-14).
 * Grok has one stream per turn: the script polls `tools grok status` and tails each running turn.
 *
 * Usage: bun .claude/skills/babysit/scripts/watch-workers.ts grok:bs-512-grok codex:bs-511-sol [--stall-s 180] [--run <dir>]…
 *        [--tools all|commands|none]
 *
 * --tools sets which tool calls print: `commands` (the default) prints shell commands only, where a commit, a push or an
 * install shows, and counts the rest at the end of the turn; `all` prints every call. One Grok round printed 40 file
 * reads and greps in its first five minutes, and eight workers at once buried the turn ends and stalls (2026-10-15).
 *
 * With --run, each line also names the PR and round the worker was last steered to (from the run's ledger): a worker
 * keeps its first PR's name across later PRs, so "bs-compress turn 13" read as the compress PR taking 13 turns when
 * it was #516 round 3 (2026-10-14).
 */
import { existsSync, statSync } from "node:fs";
import { execTool } from "@genesiscz/utils/cli";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { turnLogPath } from "@genesiscz/utils/grok/worker-paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { type LedgerEvent, ledgerPath, readEvents } from "./ledger";

const args = process.argv.slice(2);
const stallIndex = args.indexOf("--stall-s");
const STALL_MS = (stallIndex >= 0 ? Number(args[stallIndex + 1]) : 180) * 1000;
const toolsIndex = args.indexOf("--tools");
const TOOLS = toolsIndex >= 0 ? args[toolsIndex + 1] : "commands";

if (!["all", "commands", "none"].includes(TOOLS)) {
    console.error(`--tools takes all, commands or none, got ${TOOLS}`);
    process.exit(2);
}

/** Shell tool names across backends: Grok `run_terminal_command`, Codex `exec_command` / `shell` / `exec`. */
const SHELL_TOOL = /^(run_terminal_command|exec_command|shell|exec|bash)\b/i;
const workers = args
    .filter((arg) => /^(grok|codex):/.test(arg))
    .map((spec) => {
        const [backend, name] = spec.split(":") as ["grok" | "codex", string];
        return {
            backend,
            name,
            label: `${backend}:${name}`,
            lastAt: Date.now(),
            running: false,
            stallSaid: false,
            hiddenTools: 0,
            seen: new Set<string>(),
            seenTurn: -1,
        };
    });
type Worker = (typeof workers)[number];

// --run may repeat: a worker steered from another repository's run (GenesisPlayground) logs into that run's ledger,
// and a watcher reading one ledger kept naming its first PR and round (2026-10-14, bs-gp "#94 r1" on round 2).
const runDirs = args.filter((_, i) => args[i - 1] === "--run");

/** Parse each ledger only when its metadata changes, and keep only its latest task per worker. */
export function createTaskLookup({
    dirs,
    read = readEvents,
}: {
    dirs: string[];
    read?: typeof readEvents;
}): (name: string) => string {
    const cache = new Map<string, { stamp: string; tasks: Map<string, LedgerEvent> }>();
    return (name) => {
        let latest: LedgerEvent | undefined;

        for (const dir of dirs) {
            let stamp = "";

            try {
                const stat = statSync(ledgerPath(dir));
                stamp = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
            } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
                    throw error;
                }
            }

            let cached = cache.get(dir);
            if (!cached || cached.stamp !== stamp) {
                const tasks = new Map<string, LedgerEvent>();

                for (const event of stamp ? read(dir) : []) {
                    if (event.worker && (event.kind === "steer" || event.kind === "spawn")) {
                        const previous = tasks.get(event.worker);
                        if (!previous || previous.at <= event.at) {
                            tasks.set(event.worker, event);
                        }
                    }
                }

                cached = { stamp, tasks };
                cache.set(dir, cached);
            }

            const task = cached.tasks.get(name);
            if (task && (!latest || latest.at <= task.at)) {
                latest = task;
            }
        }

        return latest?.pr ? " #" + latest.pr + (latest.round ? " r" + latest.round : "") : "";
    };
}

const currentTask = createTaskLookup({ dirs: runDirs });
const say = (w: Worker, text: string) =>
    console.log(`[${w.label}${currentTask(w.name)}] ${text.replace(/\s+/g, " ").slice(0, 220)}`);

const MARKERS = /^(▶|✔|✖|⏸|■|⚠|🛑|❓)/u;

/** The count of the tool calls `--tools` kept quiet, once per turn end. */
function flushHidden(w: Worker): void {
    if (w.hiddenTools > 0) {
        say(w, `${w.hiddenTools} more tool call(s) not printed (--tools ${TOOLS})`);
        w.hiddenTools = 0;
    }
}

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
        let offset = 0;
        const turn = w.seenTurn;

        for await (const chunk of child.stdout) {
            buf += decoder.decode(chunk, { stream: true });
            let nl = buf.indexOf("\n");

            while (nl >= 0) {
                const line = buf.slice(0, nl).trimEnd();
                buf = buf.slice(nl + 1);
                nl = buf.indexOf("\n");

                // Grok tails replay a turn from its start. Position identifies an event; display text does not.
                const identity = `${turn}:${offset++}`;

                if (w.backend === "grok") {
                    if (w.seen.has(identity)) {
                        continue;
                    }

                    w.seen.add(identity);
                }

                if (!line.trim()) {
                    continue;
                }

                w.lastAt = Date.now();
                w.stallSaid = false;

                if (line.startsWith("🔧")) {
                    const call = line.slice(2).trim();

                    if (TOOLS === "all" || (TOOLS === "commands" && SHELL_TOOL.test(call))) {
                        say(w, `tool ${call}`);
                    } else {
                        w.hiddenTools++;
                    }
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

            // The set retains turn/position identities across tail restarts, including earlier turns.
            // While a new turn has no log yet the tail reads the finished turn and ends at once, so this branch runs
            // on every poll: the RUNNING line prints once per turn, not once per poll.
            if (status.turns !== w.seenTurn) {
                w.seenTurn = status.turns;
                say(w, `turn ${status.turns} RUNNING`);
            }

            // The tail follows the newest log file. Until the running turn has written its own, that is the turn
            // before it, which the tail replays and ends at once (#521 turns 2 to 4, 2026-10-15). Wait for the turn's
            // own file, with a deadline.
            const deadline = Date.now() + 60_000;

            while (!existsSync(turnLogPath(w.name, status.turns)) && Date.now() < deadline) {
                await Bun.sleep(1000);
            }

            if (!existsSync(turnLogPath(w.name, status.turns))) {
                say(w, `turn ${status.turns} log unavailable after 60 s`);
                await Bun.sleep(3000);
                continue;
            }

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

            // Preserve counts while a partial tail restarts; replayed positions are skipped by pump.
            if (!end?.running) {
                flushHidden(w);
                say(w, `turn ${end?.turns ?? "?"} ENDED exit=${end?.exitCode ?? "?"}`);
            }

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
