#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { runTranscriptDoor } from "@genesiscz/utils/ai/transcripts/door";
import { THOUGHT_MODES, TRANSCRIPT_FORMATS } from "@genesiscz/utils/ai/transcripts/render";
import { runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import { WORKER_CAPABILITIES } from "@genesiscz/utils/worker/capabilities";
import { surfacesFromFlags } from "@genesiscz/utils/worker/isolation";
import { runningTurnPids as findRunningTurns } from "@genesiscz/utils/worker/ps";
import { printWorkerTurn } from "@genesiscz/utils/worker/turn-report";
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
    printWorkerTurn({
        backend: "grok",
        name: result.meta.name,
        turn: result.turn,
        ended: result.summary.ended,
        exitCode: result.exitCode,
        report: result.summary.report,
        stderr: result.stderr,
        errPath: result.errPath,
        toolCalls: result.summary.toolCalls,
        // A read-only turn changes nothing by design; a replay has no snapshot to compare.
        worktree:
            result.worktree !== null && !result.meta.readOnly ? { cwd: result.meta.cwd, ...result.worktree } : null,
        logPath: result.logPath,
        transcriptHint: `tools grok read --name ${result.meta.name} --turn ${result.turn} --format compact`,
    });
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
    .option("--skills", "load your personal skills (~/.agents, ~/.claude); the default")
    .option("--no-skills", "hide your personal skills from the worker (sticky across steers)")
    .option("--rules", "load your personal rules (~/.claude rules and CLAUDE.md); the default")
    .option("--no-rules", "hide your personal rules from the worker (sticky across steers)")
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
            surfaces: surfacesFromFlags({ skills: options.skills, rules: options.rules }),
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
    .option("--skills", "load your personal skills from this turn on")
    .option("--no-skills", "hide your personal skills from this turn on")
    .option("--rules", "load your personal rules from this turn on")
    .option("--no-rules", "hide your personal rules from this turn on")
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
            surfaces: { skills: options.skills, rules: options.rules },
        });
        printTurn(result);
    });

program
    .command("read")
    .description("Re-print a finished turn: its report (default), or the transcript in a chosen --format")
    .requiredOption("--name <name>", "session name")
    .option("--turn <n>", "turn number (default: latest)")
    .option("--format [value]", `transcript shape: ${TRANSCRIPT_FORMATS.join(" | ")}`)
    .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
    .option("--events", "alias of --format events")
    .action(async (options) => {
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

        if (options.format !== undefined || options.events) {
            await runTranscriptDoor({
                tool: "tools grok",
                subcommand: ["read"],
                provider: "grok",
                query: meta.name,
                format: options.format,
                thoughts: options.thoughts,
                events: options.events,
                turnFile: logPath,
            });
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
    .command("tail")
    .description("Follow the running turn's transcript as it is written; stops when the turn ends")
    .requiredOption("--name <name>", "session name")
    .option("--format [value]", `transcript shape: ${TRANSCRIPT_FORMATS.join(" | ")} (default compact)`)
    .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
    .action(async (options) => {
        const store = new GrokSessionStore();
        const meta = store.readMeta(options.name);
        if (!meta) {
            throw new Error(`Grok session not found: ${options.name}`);
        }

        await runTranscriptDoor({
            tool: "tools grok",
            subcommand: ["tail"],
            provider: "grok",
            query: meta.name,
            format: options.format,
            thoughts: options.thoughts,
            follow: true,
            stillRunning: async () => (await runningTurnPids(meta.sessionId)).length > 0,
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
