import type { Command } from "commander";
import { getSessionInfo } from "@app/task/lib/get-session-info";
import { withResolvedSession } from "@app/task/lib/with-resolved-session";

export function registerGetCommand(program: Command): void {
    program
        .command("get")
        .description("Show session info panel (state, files, flags cheat sheet)")
        .action(async () => {
            const globalOpts = program.opts<{ session?: string }>();

            await withResolvedSession(globalOpts.session, getSessionInfo);
        });
}
