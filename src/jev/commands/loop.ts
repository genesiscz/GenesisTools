import { NativeControlDriver } from "@app/control/lib/decision/native";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { createAxSurface } from "../lib/loop/ax";
import { createBrowserSurface } from "../lib/loop/browser";
import { runGoalLoop } from "../lib/loop/run";

export function registerLoop(program: Command): void {
    program
        .command("loop")
        .description("Goal-driven see/act loop for a native app or a CDP page")
        .requiredOption("--goal <text>", "Task scoped to this surface")
        .option("--app <name>", "Native AX target")
        .option("--window-id <id>", "Pin one window")
        .option("--browser", "Use chrome-devtools page snapshot")
        .option("--port <n>", "CDP port", "9222")
        .option("--max-steps <n>", "Action attempts", "8")
        .option("--yes", "Allow high-risk acts")
        .action(
            async (options: {
                goal: string;
                app?: string;
                windowId?: string;
                browser?: boolean;
                port: string;
                maxSteps: string;
                yes?: boolean;
            }) => {
                if (options.browser && options.app) {
                    out.log.error("--browser and --app are mutually exclusive in v1.");
                    process.exitCode = 1;
                    return;
                }

                if (!options.browser && !options.app) {
                    out.log.error("loop needs --app or --browser.");
                    process.exitCode = 1;
                    return;
                }

                const controller = new AbortController();
                const cancel = () => controller.abort();
                process.once("SIGINT", cancel);
                try {
                    const surface = options.browser
                        ? createBrowserSurface({ port: Number(options.port) })
                        : createAxSurface(
                              new NativeControlDriver({
                                  app: options.app ?? "",
                                  windowId: options.windowId ? Number(options.windowId) : undefined,
                              })
                          );
                    const result = await runGoalLoop({
                        goal: options.goal,
                        surface,
                        maxSteps: Number(options.maxSteps),
                        allowYes: options.yes === true,
                        signal: controller.signal,
                        evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                    });
                    out.result(result);
                    if (result.status !== "verified") {
                        process.exitCode = 1;
                    }
                } finally {
                    process.off("SIGINT", cancel);
                }
            }
        );
}
