import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { printRunBanner, printRunExitSummary } from "@app/task/lib/banner";
import { resolveRunMode } from "@app/task/lib/run-mode";
import { runTask } from "@app/task/lib/runner";
import { TaskSessionStore } from "@app/task/lib/session-store";

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
                process.exit(1);
            }

            let session = opts.session ?? globalOpts.session;
            if (!session) {
                if (!isInteractive()) {
                    out.printlnErr("error: --session required in non-interactive mode.");
                    out.printlnErr(
                        suggestCommand("tools task", { add: ["run", "--session", "my-session", "--", ...command] })
                    );
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

            const store = new TaskSessionStore();
            const resolved = await store.resolveRunSessionName(session);

            if (resolved.renamed) {
                out.printlnErr(
                    `note: session "${resolved.requested}" already exists — using "${resolved.session}"`
                );
                out.printlnErr(`task-session-id: ${resolved.session}`);
            }

            printRunBanner({ session: resolved.session, command, mode });

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
