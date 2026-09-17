import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { circuitCache } from "../lib/arena/cache";
import { CIRCUIT_TIERS } from "../lib/arena/circuit";
import { decideArena } from "../lib/arena/policy";
import { simulateArena } from "../lib/arena/simulate";
import { ARENA_MODES } from "../lib/arena/types";
import { readInput } from "./evaluate";

export function registerArena(program: Command): void {
    const arena = program.command("arena").description("Fly arena, cached MaleCNS circuits and Jev policy");
    arena
        .command("circuits")
        .description("List circuit sizes and local cache state without downloading")
        .action(async () => out.result(await circuitCache.status()));
    arena
        .command("load")
        .argument("[tier]", "compact, balanced, standard, or expanded", "compact")
        .option("--full", "Print the complete circuit instead of its manifest")
        .description("Download the chosen circuit on demand, verify it, and cache it")
        .action(async (tierId: string, options: { full?: boolean }) => {
            const loaded = await circuitCache.load({ tierId });
            out.result(options.full ? loaded : { cacheHit: loaded.cacheHit, manifest: loaded.graph.manifest });
        });
    arena
        .command("decide")
        .argument("<file>")
        .description("Ask Jev for one action from an arena observation JSON")
        .action(async (file: string) =>
            out.result(await decideArena({ observation: await readInput(file), provider: selectedProvider(program) }))
        );
    arena
        .command("simulate")
        .description("Run the same arena engine without rendering; human mode supplies no movement")
        .option("--mode [mode]", "Controller: human, malecns, jev, hybrid", "malecns")
        .option("--circuit [tier]", "Circuit size: compact, balanced, standard, expanded", "compact")
        .option("--wiring [wiring]", "Connection control: original, shuffled, disconnected", "original")
        .option("--seed <seed>", "Reproducible level seed", "42")
        .option("--seconds <seconds>", "Simulation duration, at most 60", "10")
        .option("--jev-every <seconds>", "Simulated seconds between paid decisions", "2")
        .action(
            async (options: {
                mode: string | boolean;
                circuit: string | boolean;
                wiring: string | boolean;
                seed: string;
                seconds: string;
                jevEvery: string;
            }) => {
                for (const [flag, value, values] of [
                    ["--mode", options.mode, ARENA_MODES],
                    ["--circuit", options.circuit, CIRCUIT_TIERS.map((tier) => tier.id)],
                    ["--wiring", options.wiring, ["original", "shuffled", "disconnected"]],
                ] as const) {
                    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
                        out.log.error(suggestEnumFlag("tools jev arena simulate", flag, [...values]));
                        process.exitCode = 1;
                        return;
                    }
                }
                const controller = new AbortController();
                const abort = () => controller.abort();
                process.once("SIGINT", abort);
                try {
                    out.result(
                        await simulateArena({
                            input: {
                                mode: options.mode,
                                tierId: options.circuit,
                                wiring: options.wiring,
                                seed: Number(options.seed),
                                seconds: Number(options.seconds),
                                decisionEvery: Number(options.jevEvery),
                            },
                            signal: controller.signal,
                            provider: selectedProvider(program),
                        })
                    );
                } finally {
                    process.off("SIGINT", abort);
                }
            }
        );
}
