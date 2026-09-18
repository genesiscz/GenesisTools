import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { compactMessages, messageSchema } from "../lib/compact";

export function registerCompact(program: Command): void {
    program
        .command("compact")
        .description("Two-layer session compaction: Jev keep/drop, optional LLM summaries of truncations")
        .argument("<file>", "JSON/JSONL messages or -")
        .option("--keep <p>", "Keep threshold", "0.5")
        .option("--preserve-recent <n>", "Pinned recent tool calls", "4")
        .option("--head-chars <n>", "Truncation head", "300")
        .option("--min-reduction <p>", "Fallback if reduction is below this", "0.25")
        .option("--llm", "Layer 2: summarize truncated results, then Jev-check faithfulness")
        .action(
            async (
                file: string,
                options: {
                    keep: string;
                    preserveRecent: string;
                    headChars: string;
                    minReduction: string;
                    llm?: boolean;
                }
            ) => {
                const raw = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
                const parsed = SafeJSON.parse(raw);
                const messages = Array.isArray(parsed) ? parsed : parsed.messages;
                const result = await compactMessages({
                    messages: z.array(messageSchema).parse(messages),
                    evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                    keep: Number(options.keep),
                    preserveRecent: Number(options.preserveRecent),
                    headChars: Number(options.headChars),
                    minReduction: Number(options.minReduction),
                    llm: options.llm,
                });
                out.result(result);
            }
        );
}
