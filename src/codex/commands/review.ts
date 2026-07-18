import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { sendControlRequest } from "../lib/control-channel";

type ReviewScope = "auto" | "working-tree" | "branch";

export function registerReviewCommand(program: Command): void {
    program
        .command("review")
        .description("Start a native or adversarial Codex review")
        .requiredOption("--name <name>", "Session name")
        .option("--base <ref>", "Base branch or ref")
        .option("--scope <scope>", "auto | working-tree | branch", "auto")
        .option("--adversarial [focus...]", "Run a skeptical turn instead of native review")
        .action(
            async (options: { name: string; base?: string; scope: ReviewScope; adversarial?: boolean | string[] }) => {
                if (!(["auto", "working-tree", "branch"] as string[]).includes(options.scope)) {
                    throw new Error("--scope must be auto, working-tree, or branch");
                }

                const adversarial =
                    options.adversarial === true
                        ? []
                        : Array.isArray(options.adversarial)
                          ? options.adversarial
                          : undefined;
                const response = await sendControlRequest(options.name, {
                    op: "review",
                    scope: options.scope,
                    ...(options.base ? { base: options.base } : {}),
                    ...(adversarial ? { adversarial } : {}),
                });
                if (!response.ok) {
                    throw new Error(response.error);
                }

                out.result(SafeJSON.stringify(response.result ?? {}, null, 2));
            }
        );
}
