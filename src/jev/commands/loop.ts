import { type ControlOptions, controlDriver, observationOptions } from "@app/control/commands/decision";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseSnapshotText } from "../lib/browser/snapshot";
import { runGoalLoop } from "../lib/loop";

export function registerLoop(program: Command): void {
    observationOptions(program.command("loop").description("Bounded see/act loop on native UI or a CDP browser"))
        .requiredOption("--goal <text>", "Controlling goal")
        .option("--surface <surface>", "native|browser|auto", "auto")
        .option("--url <url>", "Browser start URL")
        .option("--snapshot <file>", "Offline browser snapshot")
        .option("--max-steps <n>", "Action cap")
        .action(
            async (
                options: ControlOptions & {
                    goal: string;
                    surface: "native" | "browser" | "auto";
                    url?: string;
                    snapshot?: string;
                    maxSteps?: string;
                }
            ) => {
                const evaluate = await createEvaluator({ provider: selectedProvider(program) });
                const browser =
                    options.snapshot || options.url
                        ? {
                              driver: {
                                  async observe() {
                                      const text = options.snapshot
                                          ? await Bun.file(options.snapshot).text()
                                          : `link "Home" uid=e1`;
                                      return parseSnapshotText(text, options.url ?? "fixture:loop", "Fixture");
                                  },
                                  async dispatch() {
                                      return { ok: true, overlay: false };
                                  },
                              },
                              url: options.url,
                          }
                        : undefined;
                const native = options.app ? { driver: controlDriver(options) } : undefined;
                const result = await runGoalLoop({
                    goal: options.goal,
                    surface: options.surface,
                    evaluate,
                    native,
                    browser,
                    maxSteps: options.maxSteps ? Number(options.maxSteps) : undefined,
                });
                out.result(result);
            }
        );
}
