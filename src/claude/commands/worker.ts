import { existsSync, readFileSync } from "node:fs";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { runTranscriptDoor } from "@genesiscz/utils/ai/transcripts/door";
import { THOUGHT_MODES, TRANSCRIPT_FORMATS } from "@genesiscz/utils/ai/transcripts/render";
import { LONG_TOKEN_MIN_LENGTH, probeLongLivedToken } from "@genesiscz/utils/claude/token-verify";
import { suggestCommand } from "@genesiscz/utils/cli";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger, out } from "@genesiscz/utils/logger";
import { WORKER_CAPABILITIES } from "@genesiscz/utils/worker/capabilities";
import { isToolCall } from "@genesiscz/utils/worker/events";
import { runningTurnPids as findRunningTurns, type RunningTurn } from "@genesiscz/utils/worker/ps";
import { printWorkerTurn } from "@genesiscz/utils/worker/turn-report";
import type { Command } from "commander";
import pc from "picocolors";
import { workerTurnErrPath, workerTurnLogPath } from "../lib/worker/paths";
import { ClaudeWorkerStore } from "../lib/worker/store";
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
    printWorkerTurn({
        backend: "claude",
        name: result.meta.name,
        turn: result.turn,
        ended: result.completed,
        exitCode: result.exitCode,
        report: result.report,
        stderr: result.stderr,
        errPath: workerTurnErrPath(result.meta.name, result.turn),
        toolCalls: result.events.filter(isToolCall),
        // No git snapshot is taken around a claude turn; the brief plus a git status check hold policy.
        worktree: null,
        logPath: result.logPath,
        transcriptHint: `tools claude worker read --name ${result.meta.name} --turn ${result.turn} --format compact`,
    });
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
        .option("--no-skills", "same as --safe-mode: claude cannot drop skills without dropping rules too")
        .option("--no-rules", "same as --safe-mode: claude cannot drop rules without dropping skills too")
        .action(
            async (options: {
                name: string;
                account: string;
                cwd: string;
                prompt?: string;
                promptFile?: string;
                model?: string;
                safeMode?: boolean;
                skills?: boolean;
                rules?: boolean;
            }) => {
                // The one switch claude -p has is --safe-mode, all or nothing. A
                // trivial turn cost $0.11 with the surfaces on and $0.06 without
                // (2026-09-01); the default follows the other backends: on.
                const safeMode = options.safeMode === true || options.skills === false || options.rules === false;
                if (safeMode && !options.safeMode) {
                    out.printlnErr(
                        pc.yellow(
                            "claude has no separate skills/rules switch; --no-skills or --no-rules means --safe-mode."
                        )
                    );
                }

                const account = await resolvePinnedAccount(options.account);
                const result = await spawnWorker({
                    name: options.name,
                    account,
                    cwd: options.cwd,
                    prompt: readPrompt(options),
                    model: options.model,
                    safeMode,
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
        .description("Re-print a finished turn's transcript: raw stream-json (default) or a chosen --format")
        .requiredOption("--name <name>", "Worker name")
        .option("--turn <n>", "Turn number (default: last)")
        .option("--format [value]", `transcript shape: ${TRANSCRIPT_FORMATS.join(" | ")}`)
        .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
        .option("--events", "alias of --format events")
        .action(
            async (options: {
                name: string;
                turn?: string;
                format?: string | boolean;
                thoughts?: string | boolean;
                events?: boolean;
            }) => {
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

                if (options.format === undefined && !options.events) {
                    out.print(readFileSync(path, "utf8"));
                    return;
                }

                await runTranscriptDoor({
                    tool: "tools claude",
                    subcommand: ["worker", "read"],
                    provider: "claude",
                    query: options.name,
                    format: options.format,
                    thoughts: options.thoughts,
                    events: options.events,
                    turnFile: path,
                });
            }
        );

    worker
        .command("tail")
        .description("Follow the running turn's transcript as it is written; stops when the turn ends")
        .requiredOption("--name <name>", "Worker name")
        .option("--format [value]", `transcript shape: ${TRANSCRIPT_FORMATS.join(" | ")} (default compact)`)
        .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
        .action(async (options: { name: string; format?: string | boolean; thoughts?: string | boolean }) => {
            const store = new ClaudeWorkerStore();
            const meta = store.readMeta(options.name);
            if (!meta) {
                throw new Error(`Claude worker not found: ${options.name}.`);
            }

            await runTranscriptDoor({
                tool: "tools claude",
                subcommand: ["worker", "tail"],
                provider: "claude",
                query: options.name,
                format: options.format,
                thoughts: options.thoughts,
                follow: true,
                stillRunning: async () => (await runningTurnPids(meta.sessionId)).length > 0,
            });
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
