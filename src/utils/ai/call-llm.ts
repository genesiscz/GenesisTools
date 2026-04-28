import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";
import { SafeJSON } from "@app/utils/json";
import type { ProviderChoice } from "@ask/types";
import { getLanguageModel } from "@ask/types/provider";
import type { LanguageModelUsage } from "ai";
import { generateObject, generateText, streamText } from "ai";
import type { z } from "zod";
import { buildProviderOptions } from "./prompt-caching";

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

export interface CallLLMStructuredOptions<T> {
    systemPrompt: string;
    userPrompt: string;
    providerChoice: ProviderChoice;
    schema: z.ZodType<T>;
    maxTokens?: number;
    temperature?: number;
}

export interface CallLLMStructuredResult<T> {
    object: T;
    /** `JSON.stringify(object, null, 2)` — convenient for activity-feed prompt logs. */
    content: string;
    usage?: LanguageModelUsage;
}

export async function callLLM(options: CallLLMOptions): Promise<CallLLMResult> {
    const { systemPrompt, userPrompt, providerChoice, streaming, maxTokens, temperature } = options;
    const providerType = providerChoice.provider.type;
    const model = getLanguageModel(providerChoice.provider.provider, providerChoice.model.id, providerType);
    const effectiveSystem = applySystemPromptPrefix(providerChoice.provider.systemPromptPrefix, systemPrompt);

    if (streaming) {
        const result = await streamText({
            model,
            system: effectiveSystem,
            prompt: userPrompt,
            providerOptions: buildProviderOptions(providerType),
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
        providerOptions: buildProviderOptions(providerType),
        ...(maxTokens ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
    });

    return { content: result.text, usage: result.usage };
}

export async function callLLMStructured<T>(options: CallLLMStructuredOptions<T>): Promise<CallLLMStructuredResult<T>> {
    const { systemPrompt, userPrompt, providerChoice, schema, maxTokens, temperature } = options;
    const providerType = providerChoice.provider.type;
    const model = getLanguageModel(providerChoice.provider.provider, providerChoice.model.id, providerType);
    const effectiveSystem = applySystemPromptPrefix(providerChoice.provider.systemPromptPrefix, systemPrompt);

    const result = await generateObject({
        model: model as unknown as Parameters<typeof generateObject>[0]["model"],
        system: effectiveSystem,
        prompt: userPrompt,
        schema,
        providerOptions: buildProviderOptions(providerType),
        ...(maxTokens ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
    });

    return {
        object: result.object as T,
        content: SafeJSON.stringify(result.object, null, 2),
        usage: result.usage,
    };
}
