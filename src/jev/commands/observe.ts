import {
    type ControlOptions,
    controlDriver,
    deadline,
    observationOptions,
    readObservation,
} from "@app/control/commands/decision";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { observeFanout } from "../lib/observe-fanout";

export function registerObserve(program: Command): void {
    observationOptions(program.command("observe").description("Read-only Jev fan-out on one or more see snapshots"))
        .requiredOption("--goal <text>", "Task scoped to this app/window")
        .option("--updates <n>", "Reobserve this many times", "1")
        .option("--interval <ms>", "Delay between updates", "250")
        .option("--snapshot-file <file>", "Use a retained see snapshot")
        .action(async (options: ControlOptions & { goal: string; updates: string; interval: string }) => {
            const updates = Math.max(1, Math.min(10, Number(options.updates)));
            const interval = Math.max(100, Math.min(2000, Number(options.interval)));
            const signal = deadline(options);
            const evaluate = await createEvaluator({ provider: selectedProvider(program) });
            const rows = [];
            for (let index = 0; index < updates; index++) {
                const observation =
                    options.snapshotFile && index === 0
                        ? await readObservation(options, signal)
                        : await controlDriver(options).observe({ signal, timeoutMs: Number(options.timeout) });
                const fanout = await observeFanout({ observation, goal: options.goal, evaluate, signal });
                rows.push({
                    n: index + 1,
                    window: observation.window,
                    dispatchable: fanout.dispatchable,
                    target: fanout.target,
                    verb: fanout.verb,
                    done: fanout.done,
                    blocked: fanout.blocked,
                    wait: fanout.wait,
                    risk: fanout.risk,
                });
                if ((fanout.done ?? 0) >= 0.8 || (fanout.blocked ?? 0) >= 0.8) {
                    break;
                }
                if (index + 1 < updates) {
                    await Bun.sleep(interval);
                }
            }
            out.result({ updates: rows });
        });
}
