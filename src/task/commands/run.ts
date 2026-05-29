import { logger, out } from "@app/logger";
import { printRunBanner, printRunExitSummary } from "@app/task/lib/banner";
import { loadTaskToolConfig } from "@app/task/lib/config";
import { pollSessionExitCode, shouldSuperviseDetachedRun, spawnDetachedRunWorker } from "@app/task/lib/detached-run";
import { runSessionGc } from "@app/task/lib/gc";
import { resolveRunSession } from "@app/task/lib/resolve-run-session";
import { resolveRunMode } from "@app/task/lib/run-mode";
import { runTask } from "@app/task/lib/runner";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { suggestClearOlderThanSeq, suggestTail } from "@app/task/lib/suggest-flags";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

function printExplicitReuseWarnings(session: string, previousLastSeq: number | undefined): void {
    out.printlnErr(pc.yellow(`warn: reusing existing session "${session}" (append mode)`));

    if (previousLastSeq !== undefined && previousLastSeq > 0) {
        out.printlnErr(pc.dim(`info: last seq ${previousLastSeq}; new lines continue from ${previousLastSeq + 1}`));
    }

    out.printlnErr(pc.dim(`info: tail live output: ${suggestTail(session)}`));

    if (previousLastSeq !== undefined && previousLastSeq > 0) {
        out.printlnErr(pc.dim(`info: clear older lines: ${suggestClearOlderThanSeq(session, previousLastSeq)}`));
    }
}

export function registerRunCommand(program: Command): void {
    program
        .command("run")
        .description("Run a command with PTY/pipe capture and pass-through")
        .option("--session <name>", "Session name for log files")
        .option("--tty", "Force PTY mode (interactive)")
        .option("--no-tty", "Force pipe mode (non-interactive)")
        .allowUnknownOption()
        .allowExcessArguments()
        .argument("[command...]", "Command after -- (e.g. run --session s -- bash -c 'echo hi')")
        .action(async (commandParts: string[], opts: { session?: string; tty?: boolean }) => {
            const globalOpts = program.opts<{ session?: string }>();
            const command = commandParts.filter(Boolean);

            if (command.length === 0) {
                out.printlnErr("error: Command required after --");
                out.printlnErr("error: Example: tools task run --session metro -- bash -c 'echo hi'");
                await out.flush();
                process.exit(1);
            }

            const explicitSessionFromFlag = opts.session ?? globalOpts.session;
            let session = explicitSessionFromFlag;
            const explicitSessionFlag = Boolean(explicitSessionFromFlag);

            if (!session) {
                if (!isInteractive()) {
                    out.printlnErr("error: --session required in non-interactive mode.");
                    out.printlnErr(
                        suggestCommand("tools task", { add: ["run", "--session", "my-session", "--", ...command] })
                    );
                    await out.flush();
                    process.exit(1);
                }

                const picked = await p.text({
                    message: "Session name for logs",
                    placeholder: "metro",
                    validate: (value) => {
                        if (!value?.trim()) {
                            return "Session name is required";
                        }

                        return undefined;
                    },
                });

                if (p.isCancel(picked)) {
                    process.exit(1);
                }

                session = picked.trim();
            }

            const mode = resolveRunMode({ tty: opts.tty });

            const taskConfig = loadTaskToolConfig();
            if (taskConfig.gcOnRunStart) {
                try {
                    await runSessionGc({ retentionDays: taskConfig.sessionRetentionDays });
                } catch (err) {
                    logger.warn({ err }, "gc: failed");
                }
            }

            const store = new TaskSessionStore();
            const resolved = await resolveRunSession(store, session, {
                explicitSessionFlag,
                interactive: isInteractive(),
            });

            if (!resolved) {
                process.exit(1);
            }

            if (resolved.renamed) {
                out.printlnErr(`note: session "${resolved.requested}" already exists — using "${resolved.session}"`);
                out.printlnErr(`task-session-id: ${resolved.session}`);
            }

            if (resolved.reuse === "reuse-continue" && explicitSessionFlag) {
                printExplicitReuseWarnings(resolved.session, resolved.previousLastSeq);
            }

            printRunBanner({ session: resolved.session, command, mode });

            if (shouldSuperviseDetachedRun()) {
                const toolsEntry = process.argv[1] ?? "tools";
                const worker = spawnDetachedRunWorker({
                    toolsEntry,
                    session: resolved.session,
                    command,
                    mode,
                    forceTty: opts.tty === true,
                    forceNoTty: opts.tty === false,
                });
                worker.unref();

                const exitCode = await pollSessionExitCode(resolved.session);
                printRunExitSummary({
                    session: resolved.session,
                    exitCode,
                    durationMs: 0,
                });
                process.exit(exitCode);
            }

            const result = await runTask({
                session: resolved.session,
                resolved,
                command,
                mode,
            });

            printRunExitSummary({
                session: result.session,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
            });
            process.exit(result.exitCode);
        });
}
