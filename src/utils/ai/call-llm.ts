import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";
import type { ProviderChoice } from "@ask/types";
import { getLanguageModel } from "@ask/types/provider";
import type { LanguageModelUsage } from "ai";
import { generateText, streamText } from "ai";

export interface CallLLMOptions {
    systemPrompt: string;
    userPrompt: string;
    providerChoice: ProviderChoice;
    streaming?: boolean;
    maxTokens?: number;
    temperature?: number;
    /** Write streaming chunks to this writable (defaults to process.stdout) */
    streamTarget?: NodeJS.WritableStream;
}

export interface CallLLMResult {
    content: string;
    usage?: LanguageModelUsage;
}

export async function callLLM(options: CallLLMOptions): Promise<CallLLMResult> {
    const { systemPrompt, userPrompt, providerChoice, streaming, maxTokens, temperature } = options;
    const model = getLanguageModel(providerChoice.provider.provider, providerChoice.model.id);

    const effectiveSystem = applySystemPromptPrefix(providerChoice.provider.systemPromptPrefix, systemPrompt);

    if (streaming) {
        const result = await streamText({
            model,
            system: effectiveSystem,
            prompt: userPrompt,
            ...(maxTokens ? { maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
        });

        const target = options.streamTarget ?? process.stdout;
        let fullResponse = "";
        let pipeBroken = false;

        for await (const chunk of result.textStream) {
            if (pipeBroken) {
                continue;
            }

            try {
                target.write(chunk);
            } catch {
                pipeBroken = true;
            }

            fullResponse += chunk;
        }

        if (!pipeBroken) {
            try {
                target.write("\n");
            } catch {
                // Pipe closed (e.g. `| head -15`)
            }
        }

        const usage = await result.usage;
        return { content: fullResponse, usage };
    }

    const result = await generateText({
        model,
        system: effectiveSystem,
        prompt: userPrompt,
        ...(maxTokens ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
    });

    return { content: result.text, usage: result.usage };
}
