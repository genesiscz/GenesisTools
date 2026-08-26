#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import { Command } from "commander";
import { turnErrPath, turnLogPath } from "./lib/paths";
import { GrokSessionStore } from "./lib/store";
import { parseTurnLog } from "./lib/stream";
import { runSession, steerSession, type TurnResult } from "./lib/worker";

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

    out.log.success(
        `turn ${result.turn} completed — verify yourself before trusting this report (log: ${result.logPath})`
    );
}

program
    .command("run")
    .description("Start a new worker session and run turn 1 (blocking; can take minutes)")
    .requiredOption("--name <name>", "session name (the steering handle)")
    .requiredOption("--cwd <path>", "project directory the worker may touch")
    .option("--prompt-file <path>", "brief file (preferred; inline prompts break on backticks)")
    .option("--prompt <text>", "inline brief")
    .option("--model <model>", "grok model id", "grok-4.6")
    .option("--readonly", "review mode: worker gets read_file,list_dir,grep only (sticky across steers)", false)
    .option("--worker-home <path>", "override the isolated GROK_HOME (default ~/.genesis-tools/grok/worker-home)")
    .action(async (options) => {
        const result = await runSession({
            name: options.name,
            cwd: options.cwd,
            prompt: options.prompt,
            promptFile: options.promptFile,
            model: options.model,
            readOnly: Boolean(options.readonly),
            workerHome: options.workerHome,
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
        });
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

await runTool(program, { tool: "grok" });
