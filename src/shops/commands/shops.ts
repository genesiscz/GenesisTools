import type { Command } from "commander";

export function registerShopsCommand(program: Command): void {
    program
        .command("shops")
        .description("List supported shops + capability matrix")
        .action(async () => {
            process.stdout.write("Stub — implemented in Task 12.\n");
        });
}
