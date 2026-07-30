import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import { providerManager } from "@ask/providers/ProviderManager";
import type { ChatConfig, ChatMessage, DetectedProvider, ProviderChoice } from "@ask/types";
import { getLanguageModel } from "@ask/types";
import type { AIAccount } from "@genesiscz/utils/ai/AIAccount";
import { type CoreChatResult, coreChat } from "@genesiscz/utils/ai/core/call";
import {
    type AnthropicModelCategory,
    type OpenAIModelCategory,
    resolveModel as resolveModelByName,
} from "@genesiscz/utils/ask/providers/ModelResolver";
import { logger } from "@genesiscz/utils/logger";
import { estimateTokens } from "@genesiscz/utils/tokens";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";

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
        let provider: DetectedProvider;

        if (options.account) {
            provider = await options.account.provider();
        } else {
            const providers = await providerManager.detectProviders("anthropic");
            const found = providers.find((p) => p.name === "anthropic");

            if (!found) {
                throw new Error("No Claude subscription configured. Run `tools ask config` first.");
            }

            provider = found;
        }

        // `resolveModelByName` is ask's fuzzy matcher over an already-detected
        // provider's list, NOT the config-wide ladder in `utils/ai/core/resolve`.
        // Both are called `resolveModel`; this one never touches the AI config.
        const selection = resolveModelByName(options.model, provider.models);

        if (!selection.model) {
            const accountHint = options.account ? ` for account "${options.account.name}"` : "";
            throw new Error(`No "${selection.request}" model available${accountHint}`);
        }

        const config: ChatConfig = {
            model: getLanguageModel(provider.provider, selection.model.id, provider.type),
            provider: provider.name,
            modelName: selection.model.id,
            streaming: options.streaming ?? false,
            systemPrompt: options.systemPrompt,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            providerChoice: { provider, model: selection.model },
            providerType: provider.type,
        };

        const engine = new ChatEngine(config);
        return engine.sendMessage(options.message, options.tools);
    }

    /**
     * What `coreChat` needs to know about this engine's configured model.
     *
     * `accountId` / `provider` / `modelId` / `app` are not optional decoration:
     * `logUsage` falls back to `accountId: "unknown"` and `modelId: target.label`
     * when they are absent, and the label is `<provider>/<model>`, which
     * `catalogPricing`'s `byId` can never match. Every `tools ask` row was
     * therefore written unpriced and unattributed — into an append-only log, so
     * the cross-surface total the usage layer exists to produce was blind to the
     * busiest emitter in the repo.
     */
    private callTarget() {
        return {
            model: this.config.model,
            providerType: this.config.providerType,
            systemPromptPrefix: this.config.providerChoice?.provider.systemPromptPrefix,
            label: `${this.config.provider}/${this.config.modelName}`,
            accountId: this.config.providerChoice?.provider.account?.name ?? this.config.provider,
            provider: this.config.providerType ?? this.config.provider,
            modelId: this.config.modelName,
            app: "ask",
        };
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
        // Without an onChunk callback the engine is driving a terminal directly,
        // so it owns the trailing newline the interactive UI expects.
        const toStdout = !callbacks?.onChunk;

        const result = await coreChat({
            target: this.callTarget(),
            system: this.config.systemPrompt,
            messages,
            tools,
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
            stream: true,
            onChunk: callbacks?.onChunk ?? ((chunk) => process.stdout.write(chunk)),
            onThinking: callbacks?.onThinking,
            onToolCall: callbacks?.onToolCall,
            onToolResult: callbacks?.onToolResult,
        });

        if (toStdout) {
            process.stdout.write("\n");
        }

        return this.withCost(result);
    }

    private async sendNonStreamingMessage(messages: ModelMessage[], tools?: ToolSet): Promise<ChatResponse> {
        const result = await coreChat({
            target: this.callTarget(),
            system: this.config.systemPrompt,
            messages,
            tools,
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
        });

        return this.withCost(result);
    }

    /**
     * Price the call. Cost is ask's concern, not the transport's: the core call
     * reports tokens, this decides what they were worth to this provider.
     */
    private async withCost(result: CoreChatResult): Promise<ChatResponse> {
        const usage = result.usage;
        const cost = usage
            ? await dynamicPricingManager.calculateCost(this.config.provider, this.config.modelName, usage)
            : undefined;

        logger.debug({ usage, cost, model: this.config.modelName }, "[ChatEngine] call finished");

        return {
            content: result.content,
            usage,
            cost,
            responseMessages: result.responseMessages,
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

    /**
     * `providerChoice` is not decoration here.
     *
     * `/model` can move the session to a different provider TYPE, and this used
     * to update only the name and the model. `callTarget` reads `providerType`
     * for usage attribution and `providerChoice` for the system-prompt prefix, so
     * everything after a switch was recorded against the provider the session
     * started on, and subscription prefixes were applied from the old one.
     */
    async switchModel(
        newModel: LanguageModel,
        provider: string,
        modelName: string,
        providerChoice?: ProviderChoice
    ): Promise<void> {
        this.config.model = newModel;
        this.config.provider = provider;
        this.config.modelName = modelName;

        if (providerChoice) {
            this.config.providerChoice = providerChoice;
            this.config.providerType = providerChoice.provider.type;
        }

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
