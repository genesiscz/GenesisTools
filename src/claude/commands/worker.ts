import { existsSync, readFileSync } from "node:fs";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { LONG_TOKEN_MIN_LENGTH, probeLongLivedToken } from "@genesiscz/utils/claude/token-verify";
import { suggestCommand } from "@genesiscz/utils/cli";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger, out } from "@genesiscz/utils/logger";
import { WORKER_CAPABILITIES } from "@genesiscz/utils/worker/capabilities";
import { coalesceWorkerEvents, formatWorkerEvent } from "@genesiscz/utils/worker/events";
import { runningTurnPids as findRunningTurns, type RunningTurn } from "@genesiscz/utils/worker/ps";
import type { Command } from "commander";
import pc from "picocolors";
import { workerTurnLogPath } from "../lib/worker/paths";
import { ClaudeWorkerStore } from "../lib/worker/store";
import { parseTurnEvents } from "../lib/worker/stream";
import { type ClaudeTurnResult, type PinnedAccount, spawnWorker, steerWorker } from "../lib/worker/worker";
import { launchGateForVerdict } from "./exec";

const log = logger.child({ component: "claude:worker:cli" });

/**
 * Resolve the REQUIRED account for a worker. There is deliberately no autopick
 * here: `tools claude exec` without -a silently chooses by usage headroom, and
 * a handoff that bills an account nobody chose is the failure this backend
 * exists to prevent (WORKER_CAPABILITIES.claude.accountRequired).
 */
async function resolvePinnedAccount(name: string | undefined): Promise<PinnedAccount> {
    const config = await AIConfig.load();
    const eligible = config.getAccountsByProvider("anthropic-sub").filter((a) => a.tokens.longLivedToken);
    const names = eligible.map((a: AIAccountEntry) => a.name).join(", ");

    if (!name) {
        throw new Error(`--account is required for a claude worker (no autopick). With a token: ${names}`);
    }

    const match = eligible.find((a: AIAccountEntry) => a.name === name);
    if (!match) {
        throw new Error(`Account "${name}" has no long-lived token. With a token: ${names}`);
    }

    const token = match.tokens.longLivedToken ?? "";
    if (token.length < LONG_TOKEN_MIN_LENGTH) {
        // A truncated token 401s and Claude Code silently falls back to the
        // keychain login, billing the wrong account rather than failing.
        throw new Error(
            `The stored token for "${match.name}" is truncated (${token.length} chars, expect ~108). Recapture it with: tools claude login-long ${match.name}`
        );
    }

    const gate = launchGateForVerdict(await probeLongLivedToken(token), match.name);
    if (!gate.launch) {
        throw new Error(`${gate.reason} Recapture it with: ${gate.fix}`);
    }

    return { name: match.name, label: match.label, token };
}

function readPrompt(options: { prompt?: string; promptFile?: string }): string {
    if (options.promptFile) {
        return readFileSync(options.promptFile, "utf8");
    }

    if (options.prompt) {
        return options.prompt;
    }

    throw new Error("A prompt is required: pass --prompt-file <path> or --prompt '<text>'.");
}

function printTurn(result: ClaudeTurnResult): void {
    out.printlnErr(
        pc.dim(
            `turn ${result.turn} · exit ${result.exitCode} · ${result.completed ? "completed" : "did NOT complete"} · ${result.events.length} events · log ${result.logPath}`
        )
    );

    if (result.stderr.trim()) {
        out.printlnErr(pc.yellow(result.stderr.trim()));
    }

    if (result.report) {
        out.print(`${result.report}\n`);
    }

    if (!result.completed) {
        process.exitCode = 1;
    }
}

/** Live claude processes belonging to this worker's session uuid, via ps. */
function runningTurnPids(sessionId: string): Promise<RunningTurn[]> {
    // The shared helper, not a private copy: it refuses a marker shorter than 8
    // characters, which a hand-edited meta file can produce and which then
    // matches every `claude` line in the process table, the user's own
    // interactive TUI included.
    return findRunningTurns(sessionId, /claude/);
}

export function registerWorkerCommand(program: Command): void {
    const worker = program
        .command("worker")
        .description("Drive a headless claude -p session pinned to a named account (spawn/steer/read/status/stop)");

    worker
        .command("spawn")
        .description("Start a worker: turn 1 of a new pinned claude -p session (blocking; can take minutes)")
        .requiredOption("--name <name>", "Worker name")
        .requiredOption("-a, --account <account>", "Account to pin every turn to (required, never auto-picked)")
        .requiredOption("--cwd <path>", "Working directory for the worker")
        .option("--prompt <text>", "Inline prompt")
        .option("--prompt-file <path>", "Read the prompt from a file")
        .option("-m, --model <model>", "Model for the session")
        .option("--safe-mode", "Launch with claude --safe-mode (skip CLAUDE.md, hooks, skills, MCP)")
        .action(
            async (options: {
                name: string;
                account: string;
                cwd: string;
                prompt?: string;
                promptFile?: string;
                model?: string;
                safeMode?: boolean;
            }) => {
                const account = await resolvePinnedAccount(options.account);
                const result = await spawnWorker({
                    name: options.name,
                    account,
                    cwd: options.cwd,
                    prompt: readPrompt(options),
                    model: options.model,
                    safeMode: options.safeMode,
                });
                printTurn(result);
            }
        );

    worker
        .command("steer")
        .description("Send the next instruction to an existing worker (blocking; can take minutes)")
        .requiredOption("--name <name>", "Worker name")
        .option("--prompt <text>", "Inline prompt")
        .option("--prompt-file <path>", "Read the prompt from a file")
        .action(async (options: { name: string; prompt?: string; promptFile?: string }) => {
            const store = new ClaudeWorkerStore();
            const meta = store.readMeta(options.name);
            if (!meta) {
                throw new Error(`Claude worker not found: ${options.name}.`);
            }

            // Re-resolve the PINNED account, never a flag: every turn of a
            // worker bills the identity chosen at spawn.
            const account = await resolvePinnedAccount(meta.account);
            const result = await steerWorker({ name: options.name, account, prompt: readPrompt(options) });
            printTurn(result);
        });

    worker
        .command("read")
        .description("Re-print a finished turn's transcript, raw or as shared worker events")
        .requiredOption("--name <name>", "Worker name")
        .option("--turn <n>", "Turn number (default: last)")
        .option("--events", "Print normalized worker events instead of raw stream-json")
        .action(async (options: { name: string; turn?: string; events?: boolean }) => {
            const store = new ClaudeWorkerStore();
            const meta = store.readMeta(options.name);
            if (!meta) {
                throw new Error(`Claude worker not found: ${options.name}.`);
            }

            const turn = options.turn ? Number.parseInt(options.turn, 10) : meta.turns;
            const path = workerTurnLogPath(options.name, turn);
            if (!existsSync(path)) {
                throw new Error(`No transcript for turn ${turn} of '${options.name}'.`);
            }

            const text = readFileSync(path, "utf8");
            if (!options.events) {
                out.print(text);
                return;
            }

            for (const event of coalesceWorkerEvents(parseTurnEvents(text, meta.sessionId))) {
                const line = formatWorkerEvent(event);
                if (line) {
                    out.println(line);
                }
            }
        });

    worker
        .command("status")
        .description("Show a worker's metadata, last turn, and whether a turn is running right now")
        .requiredOption("--name <name>", "Worker name")
        .action(async (options: { name: string }) => {
            const store = new ClaudeWorkerStore();
            const meta = store.readMeta(options.name);
            if (!meta) {
                throw new Error(`Claude worker not found: ${options.name}.`);
            }

            const running = await runningTurnPids(meta.sessionId);
            out.result({
                ...meta,
                running: running.length > 0,
                runningPids: running.map((r) => r.pid),
            });
        });

    worker
        .command("stop")
        .description("Kill the currently running turn of a worker (the session survives; steer resumes it)")
        .requiredOption("--name <name>", "Worker name")
        .action(async (options: { name: string }) => {
            const store = new ClaudeWorkerStore();
            const meta = store.readMeta(options.name);
            if (!meta) {
                throw new Error(`Claude worker not found: ${options.name}.`);
            }

            const running = await runningTurnPids(meta.sessionId);
            if (running.length === 0) {
                out.printlnErr(pc.dim(`No running turn for '${options.name}'. Nothing to stop.`));
                return;
            }

            for (const target of running) {
                log.info({ pid: target.pid, command: target.command }, "stopping claude worker turn");
                // pid-verified: runningTurnPids matched this pid's live `ps` command line against the session id and the binary just above; a recycled pid does not carry that marker
                process.kill(target.pid, "SIGTERM");
            }

            out.printlnErr(
                pc.dim(
                    `Sent SIGTERM to ${running.length} process(es). The session survives; 'tools claude worker steer' resumes it.`
                )
            );
        });

    worker
        .command("sessions")
        .description("List claude workers")
        .action(() => {
            const store = new ClaudeWorkerStore();
            const names = store.listNames();
            if (names.length === 0) {
                out.printlnErr(pc.dim("No claude workers."));
                out.printlnErr(
                    pc.dim(
                        suggestCommand("tools claude worker spawn", { add: ["--name", "<task>", "-a", "<account>"] })
                    )
                );
                return;
            }

            for (const name of names) {
                const meta = store.readMeta(name);
                out.println(
                    `${name}  turns=${meta?.turns ?? "?"}  account=${meta?.account ?? "?"}  cwd=${meta?.cwd ?? "?"}`
                );
            }
        });

    // Verbs other backends have and this one deliberately lacks: name the
    // capability matrix instead of pretending commander never heard of them.
    for (const [verb, reason] of Object.entries(WORKER_CAPABILITIES.claude.absentVerbs)) {
        worker
            .command(verb, { hidden: true })
            .description(`Not available: ${reason}`)
            .action(() => {
                out.error(pc.red(`'tools claude worker ${verb}' does not exist by design: ${reason}`));
                out.printlnErr(pc.dim("See WORKER_CAPABILITIES.claude in @genesiscz/utils/worker/capabilities."));
                process.exitCode = 1;
            });
    }
}
