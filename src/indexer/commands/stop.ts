import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerStopCommand(program: Command): void {
    program
        .command("stop")
        .description("Stop an in-progress index operation")
        .argument("<name>", "Index name")
        .action(async (name: string) => {
            const storage = new Storage("indexer");
            const stopFile = join(storage.getBaseDir(), name, "stop.signal");
            await Bun.write(stopFile, String(Date.now()));
            p.log.info(`Stop signal sent to "${name}". It will stop at the next checkpoint.`);
        });
}
