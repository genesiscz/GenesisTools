import { existsSync, statSync } from "node:fs";
import { out } from "@app/utils/logger";
import type { Command } from "commander";
import { sessionEventsPath } from "../lib/paths";
import { CodexSessionStore } from "../lib/store";
import { printLogs } from "./logs";

export function registerTailCommand(program: Command): void {
    program
        .command("tail")
        .description("Show recent events and optionally follow")
        .requiredOption("--name <name>", "Session name")
        .option("--tail <count>", "Show the last N existing events", "20")
        .option("--follow", "Follow until the session closes")
        .action(async (options: { name: string; tail: string; follow?: boolean }) => {
            await printLogs(options);
            if (!options.follow) {
                return;
            }

            const path = sessionEventsPath(options.name);
            let offset = existsSync(path) ? statSync(path).size : 0;
            const store = new CodexSessionStore();

            for (;;) {
                if (existsSync(path)) {
                    const size = statSync(path).size;
                    if (size > offset) {
                        const text = await Bun.file(path).slice(offset, size).text();
                        out.print(text);
                        offset = size;
                    }
                }

                const meta = await store.readMeta(options.name);
                if (!meta || meta.status === "closed" || meta.status === "failed") {
                    return;
                }

                await Bun.sleep(200);
            }
        });
}
