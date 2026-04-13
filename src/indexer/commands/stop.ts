import { join } from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { getIndexerStorage } from "../lib/storage";

export function registerStopCommand(program: Command): void {
    program
        .command("stop")
        .description("Stop an in-progress index operation")
        .argument("<name>", "Index name")
        .action(async (name: string) => {
            const stopFile = join(getIndexerStorage().getIndexDir(name), "stop.signal");
            await Bun.write(stopFile, String(Date.now()));
            p.log.info(`Stop signal sent to "${name}". It will stop at the next checkpoint.`);
        });
}
