import { out } from "@app/logger";
import type { Command } from "commander";
import { getSessionInfo } from "../lib/get-session-info";
import { TaskSessionStore } from "../lib/session-store";

export function registerGetCommand(program: Command): void {
    program
        .command("get")
        .description("Show session info panel (state, files, flags cheat sheet)")
        .action(async () => {
            const globalOpts = program.opts<{ session?: string }>();
            const store = new TaskSessionStore();

            try {
                const session = await store.resolveSession(globalOpts.session);
                await getSessionInfo(session);
            } catch (err) {
                out.printlnErr(`error: ${err instanceof Error ? err.message : String(err)}`);
                process.exit(1);
            }
        });
}
