import { join } from "node:path";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { buildCatalogue } from "../lib/route/catalogue";
import { routeUtterance } from "../lib/route/router";

export function registerRoute(program: Command): void {
    program
        .command("route")
        .description("Pick a GenesisTools command for an utterance; default prints, --run executes")
        .argument("<utterance>", "What you want a tool to do")
        .option("--run", "Execute the printed command")
        .option("--yes", "Confirm a destructive --run")
        .option("--refresh", "Rebuild the catalogue")
        .action(async (utterance: string, options: { run?: boolean; yes?: boolean; refresh?: boolean }) => {
            const srcDir = join(import.meta.dir, "..", "..");
            const catalogue = buildCatalogue(srcDir);
            void options.refresh;
            const decision = await routeUtterance({
                utterance,
                catalogue,
                evaluate: await createEvaluator({ provider: selectedProvider(program) }),
            });
            out.result(decision);
            if (decision.status !== "resolved") {
                process.exitCode = 1;
                return;
            }

            if (!options.run) {
                return;
            }

            if (decision.destructive && !options.yes && !isInteractive()) {
                out.log.error("Destructive route requires --yes in non-interactive mode.");
                process.exitCode = 1;
            }
        });
}
