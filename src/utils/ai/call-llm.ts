import { logger } from "@app/logger";
import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";
import { SafeJSON } from "@app/utils/json";
import type { ProviderChoice } from "@ask/types";
import { getLanguageModel } from "@ask/types/provider";
import type { LanguageModelUsage } from "ai";
import { generateObject, generateText, streamObject, streamText } from "ai";
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
    /**
     * When set, the call streams via `streamObject` and invokes this with each
     * best-effort partial object. Falls back silently to `generateObject` when
     * the provider rejects streaming before the first chunk.
     */
    onPartial?: (partial: unknown) => void;
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
            ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
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
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
    });

    return { content: result.text, usage: result.usage };
}

export async function callLLMStructured<T>(options: CallLLMStructuredOptions<T>): Promise<CallLLMStructuredResult<T>> {
    const { systemPrompt, userPrompt, providerChoice, schema, maxTokens, temperature, onPartial } = options;
    const providerType = providerChoice.provider.type;
    const model = getLanguageModel(providerChoice.provider.provider, providerChoice.model.id, providerType);
    const effectiveSystem = applySystemPromptPrefix(providerChoice.provider.systemPromptPrefix, systemPrompt);
    const callArgs = {
        system: effectiveSystem,
        prompt: userPrompt,
        schema,
        providerOptions: buildProviderOptions(providerType),
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
    };

    if (onPartial) {
        const streamed = await tryStreamObject<T>({ model, callArgs, onPartial });

        if (streamed) {
            return streamed;
        }
    }

    const result = await generateObject({
        model: model as unknown as Parameters<typeof generateObject>[0]["model"],
        ...callArgs,
    });

    return {
        object: result.object as T,
        content: SafeJSON.stringify(result.object, null, 2),
        usage: result.usage,
    };
}

interface TryStreamObjectOpts<T> {
    model: ReturnType<typeof getLanguageModel>;
    callArgs: {
        system: string;
        prompt: string;
        schema: z.ZodType<T>;
        providerOptions: ReturnType<typeof buildProviderOptions>;
        maxOutputTokens?: number;
        temperature?: number;
    };
    onPartial: (partial: unknown) => void;
}

/**
 * Streams a structured call via `streamObject`. Returns `null` (for a silent
 * `generateObject` fallback) when the stream fails before the first chunk;
 * errors after the first chunk propagate like a failed `generateObject` call.
 */
async function tryStreamObject<T>(opts: TryStreamObjectOpts<T>): Promise<CallLLMStructuredResult<T> | null> {
    let sawChunk = false;

    try {
        const result = streamObject({
            model: opts.model as unknown as Parameters<typeof streamObject>[0]["model"],
            ...opts.callArgs,
        });

        for await (const partial of result.partialObjectStream) {
            sawChunk = true;
            opts.onPartial(partial);
        }

        const object = (await result.object) as T;

        return {
            object,
            content: SafeJSON.stringify(object, null, 2),
            usage: await result.usage,
        };
    } catch (error) {
        if (!sawChunk) {
            logger.debug({ err: error }, "streamObject failed before first chunk — falling back to generateObject");
            return null;
        }

        throw error;
    }
}
