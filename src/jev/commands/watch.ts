import { NativeControlDriver } from "@app/control/lib/decision/native";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { runWatch } from "../lib/watch/loop";

export function registerWatch(program: Command): void {
    program
        .command("watch")
        .description("Bounded high-Hz Jev policy on one window")
        .requiredOption("--app <name>", "Target app")
        .requiredOption("--goal <text>", "Done condition")
        .option("--window-id <id>", "Pin one window")
        .option("--hz <n>", "Ticks per second (1-10)", "4")
        .option("--max-seconds <n>", "Time budget", "15")
        .option("--max-requests <n>", "Paid evaluations", "20")
        .action(
            async (options: {
                app: string;
                goal: string;
                windowId?: string;
                hz: string;
                maxSeconds: string;
                maxRequests: string;
            }) => {
                const controller = new AbortController();
                const cancel = () => controller.abort();
                process.once("SIGINT", cancel);
                try {
                    const result = await runWatch({
                        goal: options.goal,
                        hz: Number(options.hz),
                        maxSeconds: Number(options.maxSeconds),
                        maxRequests: Number(options.maxRequests),
                        signal: controller.signal,
                        evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                        driver: new NativeControlDriver({
                            app: options.app,
                            windowId: options.windowId ? Number(options.windowId) : undefined,
                        }),
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
