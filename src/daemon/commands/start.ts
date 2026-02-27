import * as p from "@clack/prompts";
import type { Command } from "commander";
import { getDaemonPid, startDaemon } from "../daemon";

export function registerStartCommand(program: Command): void {
    program
        .command("start")
        .description("Run the daemon in foreground")
        .action(async () => {
            const existing = getDaemonPid();

            if (existing) {
                p.log.info(`Daemon already running (PID ${existing})`);
                return;
            }

            p.log.info("Starting daemon in foreground... (Ctrl+C to stop)");
            await startDaemon();
        });
}
