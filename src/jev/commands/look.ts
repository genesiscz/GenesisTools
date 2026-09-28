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
        .option("--blocks", "Also print every OCR text block, not only the chosen region")
        .action(async (options: { image: string; intent: string; blocks?: boolean }) => {
            try {
                if (!(await Bun.file(options.image).exists())) {
                    throw new Error(`image not found: ${options.image}`);
                }

                await withSigint(async (signal) => {
                    const blocks = await ocrImage(options.image, { signal });
                    logger.info({ image: options.image, blocks: blocks.length }, "jev look read OCR blocks");
                    const choice = await chooseOcrTarget({
                        blocks,
                        intent: options.intent,
                        evaluator: () => createEvaluator({ provider: selectedProvider(program) }),
                        signal,
                    });
                    // Screen text outside the chosen region is untrusted UI data a caller did not ask for.
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
                        ...(options.blocks
                            ? {
                                  blocks: blocks.map((block) => ({
                                      id: block.id,
                                      text: block.text,
                                      confidence: block.confidence,
                                      px: block.px,
                                  })),
                              }
                            : { blockCount: blocks.length }),
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
