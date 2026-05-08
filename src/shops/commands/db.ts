import type { Command } from "commander";

export function registerDbCommand(program: Command): void {
    program
        .command("db")
        .description("Database administration")
        .action(async () => {
            process.stdout.write("Stub — implemented in Task 11.\n");
        });
}
