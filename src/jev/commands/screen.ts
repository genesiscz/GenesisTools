import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { screenFiles } from "../lib/screen/batch";
import { SCREEN_PURPOSES } from "../lib/screen/templates";
import { parseClaims, verifyClaims } from "../lib/screen/verify";

export function registerScreen(program: Command): void {
    program
        .command("screen")
        .description("Score files or a diff for a purpose class; does not generate review comments")
        .argument("[path]", "File or directory to screen")
        .option("--purpose [id]", "Purpose template")
        .option("--list", "List purpose templates")
        .action(async (path: string | undefined, options: { purpose?: string | boolean; list?: boolean }) => {
            if (options.list) {
                out.result([...SCREEN_PURPOSES]);
                return;
            }

            if (typeof options.purpose !== "string") {
                out.log.error(suggestEnumFlag("tools jev screen", "--purpose", [...SCREEN_PURPOSES]));
                process.exitCode = 1;
                return;
            }

            const files = path
                ? [
                      {
                          path,
                          text: (
                              await Bun.file(path)
                                  .text()
                                  .catch(() => "")
                          ).slice(0, 4000),
                      },
                  ]
                : [{ path: "stdin", text: (await Bun.stdin.text()).slice(0, 4000) }];
            out.result(
                await screenFiles({
                    files,
                    purpose: options.purpose,
                    evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                })
            );
        });

    program
        .command("verify")
        .description("Score claims against a tree using purpose-class questions")
        .option("--claims <file>", "Claims file or -")
        .option("--against <dir>", "Tree or file to judge against", "src")
        .option("--purpose [id]", "Optional purpose template")
        .option("--list", "List purpose templates")
        .action(async (options: { claims?: string; against: string; purpose?: string | boolean; list?: boolean }) => {
            if (options.list) {
                out.result([...SCREEN_PURPOSES]);
                return;
            }

            if (!options.claims) {
                out.log.error("verify needs --claims <file|->");
                process.exitCode = 1;
                return;
            }

            const text = options.claims === "-" ? await Bun.stdin.text() : await Bun.file(options.claims).text();
            const against =
                options.against === "src"
                    ? "src/"
                    : await Bun.file(options.against)
                          .text()
                          .catch(() => options.against);
            out.result(
                await verifyClaims({
                    claims: parseClaims(text),
                    against,
                    purpose: typeof options.purpose === "string" ? options.purpose : undefined,
                    evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                })
            );
        });
}
