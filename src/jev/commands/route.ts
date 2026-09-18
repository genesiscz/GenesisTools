import { resolve } from "node:path";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { routeUtterance } from "../lib/route";

export function registerRoute(program: Command): void {
    program
        .command("route")
        .description("Suggest a tools <command> for an utterance. --run executes non-destructive matches")
        .argument("<utterance>", "What you want to do")
        .option("--src <dir>", "tools source directory", resolve(import.meta.dir, "..", ".."))
        .option("--run", "Execute if admitted and not destructive")
        .option("--allow-destructive", "Allow --run for destructive tools")
        .action(async (utterance: string, options: { src: string; run?: boolean; allowDestructive?: boolean }) => {
            const result = await routeUtterance({
                utterance,
                srcDir: options.src,
                run: options.run,
                allowDestructive: options.allowDestructive,
                evaluate: await createEvaluator({ provider: selectedProvider(program) }),
            });
            out.result(result);
            process.exitCode = result.admitted ? 0 : 2;
        });
}
