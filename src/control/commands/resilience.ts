import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { replayResilience } from "../lib/decision/resilience-replay";
export function registerResilienceCommand(program: Command) {
    program
        .command("resilience-replay <case>")
        .description("Replay stale, unknown, permission, cap, reordered, renamed or ambiguous control fixtures")
        .option("--jev", "Use Jev instead of the free fixture oracle", false)
        .action(async (id: string, options: { jev: boolean }) => {
            out.result(
                await replayResilience({
                    input: { id, chooser: options.jev ? "jev" : "oracle" },
                    provider: selectedProvider(program),
                })
            );
        });
}
