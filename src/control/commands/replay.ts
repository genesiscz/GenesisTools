import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { replayCases } from "../lib/decision/fixtures";
import { replayControl } from "../lib/decision/replay";

export function registerReplayCommand(program: Command) {
    program
        .command("replay")
        .argument("[case]", "Built-in case ID or JSON file")
        .description("Replay retained decisions without desktop mutation")
        .option("--chooser [chooser]", "exact, mock, or jev", "mock")
        .option("--list", "List built-in cases")
        .action(async (name: string | undefined, options: { chooser: string | boolean; list?: boolean }) => {
            if (options.list) {
                out.result(replayCases.map(({ id, title }) => ({ id, title })));
                return;
            }
            if (!name) {
                throw new Error("Choose a case with tools control replay --list, or supply a JSON file.");
            }
            const fixture = replayCases.find((item) => item.id === name) ?? SafeJSON.parse(await Bun.file(name).text());
            out.result(
                await replayControl({
                    input: { fixture, chooser: options.chooser },
                    provider: selectedProvider(program),
                    signal: AbortSignal.timeout(60000),
                })
            );
        });
}
