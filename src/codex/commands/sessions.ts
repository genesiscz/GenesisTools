import type { Command } from "commander";
import { printStatus } from "./status";

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List Codex sessions")
        .option("--json", "Emit machine-readable JSON")
        .action(async (options: { json?: boolean }) => {
            await printStatus(options);
        });
}
