import logger from "@app/logger";
import type { AIAccount } from "@app/utils/ai/AIAccount";
import { anthropicCacheControl } from "@app/utils/ai/prompt-caching";
import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";
import { SafeJSON } from "@app/utils/json";
import { estimateTokens } from "@app/utils/tokens";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import type { AnthropicModelCategory, OpenAIModelCategory } from "@ask/providers/ModelResolver";
import type { ChatConfig, ChatMessage, DetectedProvider, ProviderChoice } from "@ask/types";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { generateText, streamText } from "ai";

export interface ChatResponse {
    content: string;
    usage?: LanguageModelUsage;
    cost?: number;
    /** SDK response messages including tool calls/results — used for multi-turn history. */
    responseMessages?: ModelMessage[];
}

export interface OneShotOptions {
    /**
     * AIAccount instance — use `AIAccount.chooseClaude("hello")` or `await AIAccount.defaultClaude()`.
     * If omitted, falls back to detecting the Anthropic provider configured in ask config.
     */
    account?: AIAccount;
    /** Model: category enum (AnthropicModelCategory / OpenAIModelCategory) or raw model ID string. */
    model: AnthropicModelCategory | OpenAIModelCategory | string;
    /** The message to send. */
    message: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    tools?: ToolSet;
    /** Default: false (non-streaming for one-shot). */
    streaming?: boolean;
}

export class ChatEngine {
    private config: ChatConfig;
    private conversationHistory: ChatMessage[] = [];
    /** SDK-native message array passed to streamText/generateText — includes tool calls/results. */
    private sdkMessages: ModelMessage[] = [];

    constructor(config: ChatConfig) {
        this.config = { ...config };
    }

    static async oneShot(options: OneShotOptions): Promise<ChatResponse> {
        const { resolveModel } = await import("@ask/providers/ModelResolver");
        const { getLanguageModel } = await import("@ask/types");

        let provider: DetectedProvider;

        if (options.account) {
            provider = await options.account.provider();
        } else {
            const { providerManager } = await import("@ask/providers/ProviderManager");
            const providers = await providerManager.detectProviders("anthropic");
            const found = providers.find((p) => p.name === "anthropic");

            if (!found) {
                throw new Error("No Claude subscription configured. Run `tools ask config` first.");
            }

            provider = found;
        }

        const selection = resolveModel(options.model, provider.models);

        if (!selection.model) {
            const accountHint = options.account ? ` for account "${options.account.name}"` : "";
            throw new Error(`No "${selection.request}" model available${accountHint}`);
        }

        const config: ChatConfig = {
            model: getLanguageModel(provider.provider, selection.model.id),
            provider: provider.name,
            modelName: selection.model.id,
            streaming: options.streaming ?? false,
            systemPrompt: options.systemPrompt,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            providerChoice: { provider, model: selection.model },
        };

        const engine = new ChatEngine(config);
        return engine.sendMessage(options.message, options.tools);
    }

    private getEffectiveSystemPrompt(): string | undefined {
        const prefix = this.config.providerChoice?.provider.systemPromptPrefix;
        const userPrompt = this.config.systemPrompt;

        if (!prefix && !userPrompt) {
            return undefined;
        }

        if (!userPrompt) {
            return prefix;
        }

        return applySystemPromptPrefix(prefix, userPrompt);
    }

    async sendMessage(
        message: string,
        tools?: ToolSet,
        callbacks?: {
            onChunk?: (chunk: string) => void;
            onThinking?: (text: string) => void;
            onToolCall?: (name: string, args: unknown) => void;
            onToolResult?: (name: string, result: unknown) => void;
        }
    ): Promise<ChatResponse> {
        // Add user message to history
        const userMessage: ChatMessage = {
            role: "user",
            content: message,
            timestamp: new Date(),
            tokens: estimateTokens(message),
        };

        this.conversationHistory.push(userMessage);

        // Push user message to SDK messages (these include tool calls/results across turns)
        this.sdkMessages.push({ role: "user", content: message });

        const sdkLengthBefore = this.sdkMessages.length;

        try {
            let response: ChatResponse;

            if (this.config.streaming) {
                response = await this.sendStreamingMessage(this.sdkMessages, tools, callbacks);
            } else {
                response = await this.sendNonStreamingMessage(this.sdkMessages, tools);
            }

            // Append SDK response messages (assistant + tool messages) for next turn context
            if (response.responseMessages) {
                this.sdkMessages.push(...response.responseMessages);
            } else {
                // Fallback: add plain assistant message if no response messages available
                this.sdkMessages.push({ role: "assistant", content: response.content });
            }

            // Add assistant response to display history
            const assistantMessage: ChatMessage = {
                role: "assistant",
                content: response.content,
                timestamp: new Date(),
                tokens: estimateTokens(response.content),
                usage: response.usage,
            };

            this.conversationHistory.push(assistantMessage);

            return response;
        } catch (error) {
            // Rollback both histories so they stay in sync
            this.conversationHistory.pop();
            this.sdkMessages.length = sdkLengthBefore;
            throw error;
        }
    }

    private async sendStreamingMessage(
        messages: ModelMessage[],
        tools?: ToolSet,
        callbacks?: {
            onChunk?: (chunk: string) => void;
            onThinking?: (text: string) => void;
            onToolCall?: (name: string, args: unknown) => void;
            onToolResult?: (name: string, result: unknown) => void;
        }
    ): Promise<ChatResponse> {
        let finishUsage: LanguageModelUsage | undefined;
        let finishCost: number | undefined;

        const hasTools = tools && Object.keys(tools).length > 0;

        const result = await streamText({
            model: this.config.model,
            messages,
            system: this.getEffectiveSystemPrompt(),
            temperature: this.config.temperature,
            providerOptions: anthropicCacheControl(),
            ...(this.config.maxTokens && { maxOutputTokens: this.config.maxTokens }),
            ...(hasTools && { tools, maxSteps: 5 }),
            onFinish: async ({ usage }) => {
                // This is called when the stream completes - usage is available HERE
                logger.debug(
                    { usage: SafeJSON.stringify(usage, null, 2) },
                    `[ChatEngine] onFinish callback called with usage`
                );
                if (usage) {
                    finishUsage = usage;
                    finishCost = await dynamicPricingManager.calculateCost(
                        this.config.provider,
                        this.config.modelName,
                        usage
                    );
                    logger.debug({ cost: finishCost }, `[ChatEngine] onFinish calculated cost`);
                }
            },
        });

        // DEBUG: Log the full result object structure
        logger.debug({ keys: Object.keys(result) }, `[ChatEngine] streamText result object keys`);
        logger.debug(
            { usage: result.usage ? SafeJSON.stringify(result.usage, null, 2) : "null/undefined" },
            `[ChatEngine] streamText result.usage`
        );
        logger.debug({ usageType: typeof result.usage }, `[ChatEngine] streamText result.usage type`);
        logger.debug(
            {
                usageStructure: result.usage
                    ? {
                          hasInputTokens: "inputTokens" in (result.usage || {}),
                          hasOutputTokens: "outputTokens" in (result.usage || {}),
                          hasTotalTokens: "totalTokens" in (result.usage || {}),
                          hasCachedInputTokens: "cachedInputTokens" in (result.usage || {}),
                          allKeys: Object.keys(result.usage || {}),
                      }
                    : "no usage object",
            },
            `[ChatEngine] streamText result.usage structure`
        );

        let fullResponse = "";
        const startTime = Date.now();

        // Stream output — use fullStream to capture both text and reasoning deltas
        for await (const part of result.fullStream) {
            if (part.type === "text-delta") {
                if (callbacks?.onChunk) {
                    callbacks.onChunk(part.text);
                } else {
                    process.stdout.write(part.text);
                }

                fullResponse += part.text;
            } else if (part.type === "reasoning-delta" && callbacks?.onThinking) {
                callbacks.onThinking(part.text);
            } else if (part.type === "tool-call") {
                callbacks?.onToolCall?.(part.toolName, "input" in part ? part.input : undefined);
            } else if (part.type === "tool-result") {
                callbacks?.onToolResult?.(part.toolName, "output" in part ? part.output : undefined);
            }
        }

        const endTime = Date.now();
        const _duration = endTime - startTime;

        // Add a newline after streaming (only for stdout, not callbacks)
        if (!callbacks?.onChunk) {
            process.stdout.write("\n");
        }

        // Wait a bit for onFinish callback to complete (it's async)
        await new Promise((resolve) => setTimeout(resolve, 100));

        // DEBUG: Log usage sources
        logger.debug({ available: !!finishUsage }, `[ChatEngine] After streaming, finishUsage available`);
        logger.debug({ usageType: typeof result.usage }, `[ChatEngine] After streaming, result.usage type`);
        logger.debug(
            { isPromise: result.usage instanceof Promise },
            `[ChatEngine] After streaming, result.usage is Promise`
        );

        // Try to get usage - prioritize onFinish callback as it's most reliable
        let usage: LanguageModelUsage | undefined;
        let cost: number | undefined;

        if (finishUsage) {
            // Use usage from onFinish callback (most reliable)
            logger.debug(
                { usage: SafeJSON.stringify(finishUsage, null, 2) },
                `[ChatEngine] Using usage from onFinish callback`
            );
            usage = finishUsage;
            cost = finishCost;
        } else if (result.usage instanceof Promise) {
            // If usage is a Promise, await it
            logger.debug(`[ChatEngine] result.usage is a Promise, awaiting...`);
            usage = await result.usage;
            logger.debug({ usage: SafeJSON.stringify(usage, null, 2) }, `[ChatEngine] Resolved usage from Promise`);
            if (usage) {
                cost = await dynamicPricingManager.calculateCost(this.config.provider, this.config.modelName, usage);
            }
        } else if (result.usage) {
            // If usage is already available
            usage = result.usage;
            logger.debug({ usage: SafeJSON.stringify(usage, null, 2) }, `[ChatEngine] result.usage available directly`);
            cost = await dynamicPricingManager.calculateCost(this.config.provider, this.config.modelName, usage);
        }

        if (!usage) {
            logger.warn(
                `[ChatEngine] No usage data available from streamText result for ${this.config.provider}/${this.config.modelName}`
            );
        }

        // Get response messages (includes tool calls/results for multi-turn history)
        const sdkResponse = await result.response;
        const responseMessages = sdkResponse.messages as ModelMessage[];

        return {
            content: fullResponse,
            usage,
            cost,
            responseMessages,
        };
    }

    private async sendNonStreamingMessage(messages: ModelMessage[], tools?: ToolSet): Promise<ChatResponse> {
        const hasTools = tools && Object.keys(tools).length > 0;

        const result = await generateText({
            model: this.config.model,
            messages,
            system: this.getEffectiveSystemPrompt(),
            temperature: this.config.temperature,
            providerOptions: anthropicCacheControl(),
            ...(this.config.maxTokens && { maxOutputTokens: this.config.maxTokens }),
            ...(hasTools && { tools, maxSteps: 5 }),
        });

        // DEBUG: Log the full result object structure
        logger.debug({ keys: Object.keys(result) }, `[ChatEngine] generateText result object keys`);
        logger.debug(
            { usage: result.usage ? SafeJSON.stringify(result.usage, null, 2) : "null/undefined" },
            `[ChatEngine] generateText result.usage`
        );
        logger.debug({ usageType: typeof result.usage }, `[ChatEngine] generateText result.usage type`);
        logger.debug(
            {
                usageStructure: result.usage
                    ? {
                          hasInputTokens: "inputTokens" in (result.usage || {}),
                          hasOutputTokens: "outputTokens" in (result.usage || {}),
                          hasTotalTokens: "totalTokens" in (result.usage || {}),
                          hasCachedInputTokens: "cachedInputTokens" in (result.usage || {}),
                          allKeys: Object.keys(result.usage || {}),
                      }
                    : "no usage object",
            },
            `[ChatEngine] generateText result.usage structure`
        );

        // Calculate cost
        let cost: number | undefined;
        if (result.usage) {
            logger.debug(
                { usage: SafeJSON.stringify(result.usage, null, 2) },
                `[ChatEngine] Calculating cost for ${this.config.provider}/${this.config.modelName}`
            );
            cost = await dynamicPricingManager.calculateCost(this.config.provider, this.config.modelName, result.usage);
            logger.debug({ cost }, `[ChatEngine] Calculated cost`);
        } else {
            logger.warn(
                `[ChatEngine] No usage data available from generateText result for ${this.config.provider}/${this.config.modelName}`
            );
        }

        return {
            content: result.text,
            usage: result.usage,
            cost,
            responseMessages: result.response.messages as ModelMessage[],
        };
    }

    updateConfig(newConfig: Partial<ChatConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    getConversationHistory(): ChatMessage[] {
        return [...this.conversationHistory];
    }

    clearConversation(): void {
        this.conversationHistory = [];
        this.sdkMessages = [];
    }

    getConversationLength(): number {
        return this.conversationHistory.length;
    }

    getTotalTokens(): number {
        return this.conversationHistory.reduce((total, msg) => total + (msg.tokens || 0), 0);
    }

    async switchModel(newModel: LanguageModel, provider: string, modelName: string): Promise<void> {
        this.config.model = newModel;
        this.config.provider = provider;
        this.config.modelName = modelName;

        logger.info(`Switched to ${provider}/${modelName}`);
    }

    setSystemPrompt(systemPrompt: string, providerChoice?: ProviderChoice): void {
        this.config.systemPrompt = systemPrompt;

        if (providerChoice) {
            this.config.providerChoice = providerChoice;
        }
    }

    setTemperature(temperature: number): void {
        this.config.temperature = temperature;
    }

    setMaxTokens(maxTokens: number): void {
        this.config.maxTokens = maxTokens;
    }

    setStreaming(streaming: boolean): void {
        this.config.streaming = streaming;
    }

    getConfig(): ChatConfig {
        return { ...this.config };
    }

    // Export conversation for saving
    exportConversation(): ChatMessage[] {
        return this.conversationHistory.map((msg) => ({
            ...msg,
            timestamp: new Date(msg.timestamp), // Ensure timestamp is a Date object
        }));
    }

    // Import conversation (for loading saved conversations)
    importConversation(messages: ChatMessage[]): void {
        this.conversationHistory = messages.map((msg) => ({
            ...msg,
            timestamp: new Date(msg.timestamp),
        }));

        // Rebuild sdkMessages from display history — tool_call/tool_result entries from prior
        // turns are lost since conversationHistory only stores user/assistant/system messages.
        // This is acceptable: imported sessions resume as plain text context without active tool chains.
        this.sdkMessages = this.conversationHistory
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    }

    // Get conversation summary for display
    getConversationSummary(): string {
        if (this.conversationHistory.length === 0) {
            return "No messages yet";
        }

        const userMessages = this.conversationHistory.filter((msg) => msg.role === "user").length;
        const assistantMessages = this.conversationHistory.filter((msg) => msg.role === "assistant").length;
        const totalTokens = this.getTotalTokens();

        return `${userMessages} user messages, ${assistantMessages} assistant responses, ${dynamicPricingManager.formatTokens(
            totalTokens
        )} total tokens`;
    }

    // Get last N messages for context limiting
    getLastMessages(count: number): ChatMessage[] {
        return this.conversationHistory.slice(-count);
    }

    // Remove old messages to keep within context window
    trimToContextWindow(maxTokens: number): void {
        const lengthBefore = this.conversationHistory.length;
        let currentTokens = this.getTotalTokens();

        while (currentTokens > maxTokens && this.conversationHistory.length > 2) {
            if (this.conversationHistory[0].role === "system") {
                const removed = this.conversationHistory.splice(1, 1)[0];
                currentTokens -= removed.tokens || 0;
            } else {
                const removed = this.conversationHistory.shift();
                currentTokens -= removed?.tokens || 0;
            }
        }

        if (this.conversationHistory.length < lengthBefore) {
            // Rebuild sdkMessages to stay in sync after trim — tool_call/tool_result entries
            // from pruned turns are dropped (trimmed context resumes without active tool chains)
            this.sdkMessages = this.conversationHistory
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

            logger.info(
                `Trimmed conversation to fit within ${dynamicPricingManager.formatTokens(maxTokens)} token limit`
            );
        }
    }
}
