import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { failPlain, printResult, withSigint } from "../lib/cli-output";
import { chooseOcrTarget, ocrImage } from "../lib/look";

export function registerLook(program: Command): void {
    program
        .command("look")
        .description("OCR an image and choose the text region that matches an intent. Read-only.")
        .requiredOption("--image <path>", "Image file to read")
        .requiredOption("--intent <text>", "What to find in the image")
        .action(async (options: { image: string; intent: string }) => {
            try {
                if (!(await Bun.file(options.image).exists())) {
                    throw new Error(`image not found: ${options.image}`);
                }

                await withSigint(async (signal) => {
                    const blocks = ocrImage(options.image);
                    logger.info({ image: options.image, blocks: blocks.length }, "jev look read OCR blocks");
                    const evaluate = await createEvaluator({ provider: selectedProvider(program) });
                    const choice = await chooseOcrTarget({ blocks, intent: options.intent, evaluate, signal });
                    printResult({
                        status: choice.status,
                        source: choice.source,
                        intent: options.intent,
                        probability: choice.probability,
                        selected: choice.selected
                            ? {
                                  id: choice.selected.id,
                                  text: choice.selected.text,
                                  confidence: choice.selected.confidence,
                                  px: choice.selected.px,
                              }
                            : null,
                        blocks: blocks.map((block) => ({
                            id: block.id,
                            text: block.text,
                            confidence: block.confidence,
                            px: block.px,
                        })),
                    });

                    if (choice.status !== "resolved") {
                        process.exitCode = 1;
                    }
                });
            } catch (error) {
                failPlain(error, { command: "look", image: options.image });
            }
        });
}
