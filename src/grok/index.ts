#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { runTool } from "@genesiscz/utils/cli";
import { parseTurnEvents } from "@genesiscz/utils/grok/stream";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import { WORKER_CAPABILITIES } from "@genesiscz/utils/worker/capabilities";
import { coalesceWorkerEvents, formatWorkerEvent } from "@genesiscz/utils/worker/events";
import { runningTurnPids as findRunningTurns } from "@genesiscz/utils/worker/ps";
import { Command } from "commander";
import { registerGrokHistoryCommand } from "./commands/history";
import { registerGrokLoginCommand } from "./commands/login";
import { registerGrokResumeCommand } from "./commands/resume";
import { registerUsageCommand } from "./commands/usage";
import { turnErrPath, turnLogPath } from "./lib/paths";
import { GrokSessionStore } from "./lib/store";
import { parseTurnLog } from "./lib/stream";
import { parseResumeLimit, runGrokTuiResume } from "./lib/tui-resume";
import { runSession, steerSession, type TurnResult } from "./lib/worker";

function runningTurnPids(sessionId: string) {
    // The grok child carries the session uuid as --session-id (turn 1) or
    // --resume (later turns), and only grok processes carry this uuid.
    return findRunningTurns(sessionId, /grok/);
}

const program = new Command();

program.name("grok").description("Drive an isolated headless grok worker: run, steer between turns, read transcripts");

function printTurn(result: TurnResult): void {
    if (result.summary.toolCalls.length > 0) {
        out.log.info(`tool calls (turn ${result.turn}):`);
        for (const call of result.summary.toolCalls) {
            out.log.message(`  ${call.tool}${call.target ? ` :: ${call.target}` : ""}`);
        }
    }

    out.print(result.summary.report.trim());

    if (!result.summary.ended) {
        out.log.error(`turn ${result.turn} died mid-flight (no end event, exit ${result.exitCode})`);
        if (result.stderr.trim()) {
            out.log.error(result.stderr.trim());
        }

        process.exitCode = 1;
        return;
    }

    // A turn can end cleanly and still have written warnings to stderr (a
    // deprecated flag, a failed tool). Dropping those on success meant the only
    // way to see them was to know the .err file existed (PR #330 review t7).
    if (result.stderr.trim()) {
        out.log.warn(`turn ${result.turn} wrote to stderr:`);
        out.log.message(result.stderr.trim());
    }

    // "The turn ended" is not "the task got done": a worker that stops cleanly having
    // written nothing prints the same success line as one that finished the job.
    if (result.worktree !== null && !result.meta.readOnly) {
        if (result.worktree.changedThisTurn === 0) {
            out.log.warn(
                `turn ${result.turn} changed NOTHING in ${result.meta.cwd} — the turn ended, but the task may be unfinished. Check, then steer to continue.`
            );
        } else {
            out.log.info(
                `turn ${result.turn} changed ${result.worktree.changedThisTurn} path(s); ${result.worktree.dirtyTotal} dirty in total`
            );
        }
    }

    out.log.success(
        `turn ${result.turn} completed — verify yourself before trusting this report (log: ${result.logPath})`
    );
}

program
    .command("run")
    .description("Start a new headless worker (--name/--cwd) or resume a grok TUI session (--resume)")
    .option("--name <name>", "worker session name (the steering handle)")
    .option("--cwd <path>", "project directory the worker may touch")
    .option("--prompt-file <path>", "brief file (preferred; inline prompts break on backticks)")
    .option("--prompt <text>", "inline brief")
    .option("--model <model>", "grok model id", "grok-4.6")
    .option("--readonly", "review mode: worker gets read_file,list_dir,grep only (sticky across steers)", false)
    .option("--worker-home <path>", "override the isolated GROK_HOME (default ~/.genesis-tools/grok/worker-home)")
    .option(
        "--auth <mode>",
        "subscription (your `grok login` in ~/.grok, the default when it exists) or api-key (XAI_API_KEY, metered)"
    )
    .option("-r, --resume [query]", "Resume a grok TUI session by id, title, or transcript (not the headless worker)")
    .option("-l, --list", "With --resume, list matching TUI sessions")
    .option("-a, --all", "With --resume, search every project")
    .option("-n, --limit <n>", "With --resume, number of sessions to show", "20")
    .action(async (options) => {
        if (options.resume !== undefined || options.list) {
            await runGrokTuiResume({
                query: typeof options.resume === "string" ? options.resume : undefined,
                list: Boolean(options.list),
                all: Boolean(options.all),
                limit: parseResumeLimit(options.limit),
            });
            return;
        }

        if (!options.name || !options.cwd) {
            throw new Error("Worker mode needs --name and --cwd. To resume a TUI session, pass --resume [query].");
        }

        if (options.auth !== undefined && options.auth !== "subscription" && options.auth !== "api-key") {
            throw new Error(`--auth must be subscription or api-key, got '${options.auth}'.`);
        }

        const result = await runSession({
            name: options.name,
            cwd: options.cwd,
            prompt: options.prompt,
            promptFile: options.promptFile,
            model: options.model,
            readOnly: options.readonly,
            workerHome: options.workerHome,
            auth: options.auth,
        });
        printTurn(result);
    });

program
    .command("steer")
    .description("Send the next instruction to an existing session (blocking; can take minutes)")
    .requiredOption("--name <name>", "session name from 'tools grok run'")
    .option("--prompt-file <path>", "instruction file")
    .option("--prompt <text>", "inline instruction")
    .option("--readonly", "switch the session to read-only from this turn on")
    .option("--writable", "switch the session back to the default project-jail mode")
    .action(async (options) => {
        let readOnly: boolean | undefined;
        if (options.readonly) {
            readOnly = true;
        } else if (options.writable) {
            readOnly = false;
        }

        const result = await steerSession({
            name: options.name,
            prompt: options.prompt,
            promptFile: options.promptFile,
            readOnly,
        });
        printTurn(result);
    });

program
    .command("read")
    .description("Re-print a finished turn's report and tool calls from its log")
    .requiredOption("--name <name>", "session name")
    .option("--turn <n>", "turn number (default: latest)")
    .option("--events", "print normalized worker events instead of the report")
    .action((options) => {
        const store = new GrokSessionStore();
        const meta = store.readMeta(options.name);
        if (!meta) {
            throw new Error(`Grok session not found: ${options.name}`);
        }

        const turn = options.turn ? Number(options.turn) : meta.turns;
        const logPath = turnLogPath(meta.name, turn);
        if (!existsSync(logPath)) {
            throw new Error(`No log for turn ${turn} of '${meta.name}' (${logPath})`);
        }

        if (options.events) {
            for (const event of coalesceWorkerEvents(parseTurnEvents(readFileSync(logPath, "utf8"), meta.sessionId))) {
                const line = formatWorkerEvent(event);
                if (line) {
                    out.println(line);
                }
            }

            return;
        }

        const summary = parseTurnLog(readFileSync(logPath, "utf8"));
        const errPath = turnErrPath(meta.name, turn);
        const stderr = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
        printTurn({
            meta,
            turn,
            summary,
            exitCode: meta.lastTurn?.turn === turn ? (meta.lastTurn?.exitCode ?? null) : null,
            stderr,
            logPath,
            errPath,
            // A replay has no before/after snapshot, so it cannot honestly claim one.
            worktree: null,
        });
    });

program
    .command("status")
    .description("Show a session's metadata, last turn, and whether a turn is running right now")
    .requiredOption("--name <name>", "session name")
    .action(async (options) => {
        const store = new GrokSessionStore();
        const meta = store.readMeta(options.name);
        if (!meta) {
            throw new Error(`Grok session not found: ${options.name}`);
        }

        const running = await runningTurnPids(meta.sessionId);
        out.result({ ...meta, running: running.length > 0, runningPids: running.map((r) => r.pid) });
    });

program
    .command("stop")
    .description("Kill the currently running turn (the session survives; the next steer resumes it)")
    .requiredOption("--name <name>", "session name")
    .action(async (options) => {
        const store = new GrokSessionStore();
        const meta = store.readMeta(options.name);
        if (!meta) {
            throw new Error(`Grok session not found: ${options.name}`);
        }

        const running = await runningTurnPids(meta.sessionId);
        if (running.length === 0) {
            out.log.info(`No running turn for '${options.name}'. Nothing to stop.`);
            return;
        }

        for (const target of running) {
            // pid-verified: runningTurnPids matched this pid's live `ps` command line against the session id and the binary just above; a recycled pid does not carry that marker
            process.kill(target.pid, "SIGTERM");
        }

        out.log.info(`Sent SIGTERM to ${running.length} process(es). The next 'tools grok steer' resumes the session.`);
    });

program
    .command("sessions")
    .description("List worker sessions")
    .action(() => {
        const store = new GrokSessionStore();
        const names = store.listNames();
        if (names.length === 0) {
            out.log.info("No grok sessions. Start one with 'tools grok run'.");
            return;
        }

        const table = createBoxTable(["NAME", "TURNS", "MODE", "LAST TURN", "SESSION ID", "CWD"]);
        for (const name of names) {
            const meta = store.readMeta(name);
            if (!meta) {
                continue;
            }

            const last = meta.lastTurn
                ? formatDotStatus(meta.lastTurn.ended ? "ok" : "err", meta.lastTurn.ended ? "completed" : "died")
                : formatDotStatus("dim", "none");
            table.push([
                name,
                String(meta.turns),
                meta.readOnly ? "readonly" : "jail",
                last,
                meta.sessionId,
                truncateDisplay(meta.cwd, 40),
            ]);
        }

        out.println(table.toString());
    });

// Verbs other backends have and this one deliberately lacks: name the
// capability matrix instead of pretending commander never heard of them.
for (const [verb, reason] of Object.entries(WORKER_CAPABILITIES.grok.absentVerbs)) {
    program
        .command(verb, { hidden: true })
        .description(`Not available: ${reason}`)
        .action(() => {
            out.log.error(`'tools grok ${verb}' does not exist by design: ${reason}`);
            out.log.info("See WORKER_CAPABILITIES.grok in @genesiscz/utils/worker/capabilities.");
            process.exitCode = 1;
        });
}

registerGrokHistoryCommand(program);
registerGrokLoginCommand(program);
registerGrokResumeCommand(program);
registerUsageCommand(program);

await runTool(program, { tool: "grok" });
