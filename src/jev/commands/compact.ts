import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseCompactJsonl } from "../lib/compact/format";
import { compactWithJev } from "../lib/compact/llm";
import { compactStructural } from "../lib/compact/structural";

export function registerCompact(program: Command): void {
    program
        .command("compact")
        .description("Keep/drop/truncate tool results; never rewrite user or assistant text")
        .argument("[file]", "JSONL file or - for stdin", "-")
        .option("--keep <n>", "Target keep ratio", "0.5")
        .option("--pin <n>", "Pinned tail messages", "6")
        .option("--max-result <n>", "Truncate tool results to this many chars", "800")
        .option("--threshold <n>", "Minimum reduction to accept", "0.25")
        .option("--llm", "Ask Jev keep/drop/truncate per tool-call")
        .option("--table", "Print the decision table on stderr")
        .action(
            async (
                file: string,
                options: {
                    keep: string;
                    pin: string;
                    maxResult: string;
                    threshold: string;
                    llm?: boolean;
                    table?: boolean;
                }
            ) => {
                const text = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
                if (!text.trim()) {
                    out.log.error("compact needs JSONL on stdin or a file.");
                    process.exitCode = 1;
                    return;
                }

                const messages = parseCompactJsonl(text);
                const structural = {
                    keep: Number(options.keep),
                    pin: Number(options.pin),
                    maxResult: Number(options.maxResult),
                    threshold: Number(options.threshold),
                };
                const result = options.llm
                    ? await compactWithJev({
                          messages,
                          structural,
                          evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                      })
                    : compactStructural(messages, structural);
                if (options.table) {
                    out.log.info(
                        result.decisions
                            .map((decision) => `${decision.index} ${decision.kind} ${decision.reason}`)
                            .join("\n")
                    );
                }

                out.result(result);
            }
        );
}
