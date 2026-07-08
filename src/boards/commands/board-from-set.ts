import type { Command } from "commander";

// Implemented in plan Task 19.
export function registerBoardFromSetCommand(program: Command): void {
    program
        .command("board-from-set")
        .description("Create (or reuse) a board and import the current shot set")
        .action(() => {
            throw new Error("not implemented");
        });
}
