import type { Command } from "commander";

export function registerGetCommand(program: Command): void {
    program
        .command("get <url>")
        .description("Ingest a product URL — pulls history + meta from Hlídač and persists locally")
        .action(async (_url: string) => {
            process.stdout.write("Stub — implemented in Task 10.\n");
        });
}
