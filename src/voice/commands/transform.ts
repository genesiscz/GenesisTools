import { transformVoiceText, voiceTransformConfiguration } from "@genesiscz/utils/ai/voice/transform";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";

const requestSchema = z.object({ systemPrompt: z.string().max(32_000), text: z.string().max(256_000) });

export function registerVoiceTransforms(program: Command): void {
    const transforms = program
        .command("transforms")
        .description("Explicit text rewriting through configured AI accounts");
    transforms
        .command("configuration")
        .description("Read supported account and model metadata without resolving credentials")
        .option("--json", "Emit structured configuration")
        .action(async () => out.result(await voiceTransformConfiguration()));
    transforms
        .command("run")
        .requiredOption("--input <file>", "JSON file containing systemPrompt and text")
        .requiredOption("--model-ref <ref>", "Explicit @account/<id>:<model> reference")
        .option("--timeout-ms <milliseconds>", "Maximum request duration", "30000")
        .option("--json", "Emit rewritten text as structured JSON")
        .action(async (options: { input: string; modelRef: string; timeoutMs: string }) => {
            const file = Bun.file(options.input);

            if (file.size > 300_000) {
                throw new Error("Transform input exceeds 300,000 bytes.");
            }

            logger.debug({ input: options.input, bytes: file.size }, "Read explicitly selected transform input");
            const request = requestSchema.parse(SafeJSON.parse(await file.text()));
            await withInterrupt(
                async (signal) => {
                    const text = await transformVoiceText({
                        ...request,
                        modelRef: options.modelRef,
                        timeoutMs: Number(options.timeoutMs),
                        signal,
                    });
                    out.result({ text });
                },
                { handleTermination: true }
            );
        });
}
