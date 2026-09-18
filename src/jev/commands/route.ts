import { resolve } from "node:path";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { routeUtterance } from "../lib/route";
import { routePlan, zshRouteWidget } from "../lib/route-plan";

export function registerRoute(program: Command): void {
    program
        .command("route")
        .description("Suggest a tools <command> for an utterance. --run executes non-destructive matches")
        .argument("[utterance]", "What you want to do")
        .option("--src <dir>", "tools source directory", resolve(import.meta.dir, "..", ".."))
        .option("--run", "Execute if admitted and not destructive")
        .option("--allow-destructive", "Allow --run for destructive tools")
        .option("--plan", "Split on then/and then into 2-5 steps")
        .option("--suggest", "Print argv only (zsh helper)")
        .option("--zsh", "Print a zsh widget; does not write ~/.zshrc")
        .action(
            async (
                utterance: string | undefined,
                options: {
                    src: string;
                    run?: boolean;
                    allowDestructive?: boolean;
                    plan?: boolean;
                    suggest?: boolean;
                    zsh?: boolean;
                }
            ) => {
                if (options.zsh) {
                    out.println(zshRouteWidget());
                    return;
                }
                if (!utterance) {
                    throw new Error("Pass an utterance, or --zsh.");
                }
                const evaluate = await createEvaluator({ provider: selectedProvider(program) });
                if (options.plan) {
                    const result = await routePlan({
                        utterance,
                        srcDir: options.src,
                        run: options.run,
                        allowDestructive: options.allowDestructive,
                        evaluate,
                    });
                    out.result(result);
                    process.exitCode = result.blocked ? 2 : 0;
                    return;
                }
                const result = await routeUtterance({
                    utterance,
                    srcDir: options.src,
                    run: options.run,
                    allowDestructive: options.allowDestructive,
                    evaluate,
                });
                if (options.suggest) {
                    out.println(result.argv.join(" "));
                    process.exitCode = result.admitted ? 0 : 2;
                    return;
                }
                out.result(result);
                process.exitCode = result.admitted ? 0 : 2;
            }
        );
}
