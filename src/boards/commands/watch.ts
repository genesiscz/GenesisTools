import type { Command } from "commander";

// Implemented in plan Task 20.
export function registerWatchCommand(program: Command): void {
    program
        .command("watch")
        .description("Listen for open annotation work and print zero-token-idle announcements")
        .action(() => {
            throw new Error("not implemented");
        });
}
