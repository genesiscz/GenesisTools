import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import type { Command } from "commander";
import { printRunBanner, printRunExitSummary } from "../lib/banner";
import { resolveRunMode } from "../lib/run-mode";
import { runTask } from "../lib/runner";

export function registerRunCommand(program: Command): void {
    program
        .command("run")
        .description("Run a command with PTY/pipe capture and pass-through")
        .option("--session <name>", "Session name for log files")
        .option("--tty", "Force PTY mode (interactive)")
        .option("--no-tty", "Force pipe mode (non-interactive)")
        .argument("[command...]", "Command and args (use -- before flags)")
        .action(async (commandParts: string[], opts: { session?: string; tty?: boolean; noTty?: boolean }) => {
            const globalOpts = program.opts<{ session?: string }>();
            const command = commandParts.filter(Boolean);

            if (command.length === 0) {
                out.error("Command required. Example: tools task run --session metro -- npx react-native start");
                out.info(
                    suggestCommand("tools task", { add: ["run", "--session", "my-session", "--", "echo", "hello"] })
                );
                process.exit(1);
            }

            let session = opts.session ?? globalOpts.session;
            if (!session) {
                if (!isInteractive()) {
                    out.error("--session required in non-interactive mode.");
                    out.info(
                        suggestCommand("tools task", { add: ["run", "--session", "my-session", "--", ...command] })
                    );
                    process.exit(1);
                }

                session = command[0].replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || `task-${Date.now()}`;
            }

            const mode = resolveRunMode({ tty: opts.tty, noTty: opts.noTty });
            const cmdStr = command.join(" ");

            printRunBanner(session, cmdStr, mode);

            const result = await runTask({
                session,
                command,
                mode,
            });

            printRunExitSummary(session, result.exitCode, result.durationMs);
            process.exit(result.exitCode);
        });
}
