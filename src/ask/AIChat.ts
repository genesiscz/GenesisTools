import { homedir } from "node:os";
import { resolve } from "node:path";
import { ChatEngine } from "@ask/chat/ChatEngine";
import { ChatEvent } from "@ask/lib/ChatEvent";
import { ChatLog } from "@ask/lib/ChatLog";
import { ChatSession } from "@ask/lib/ChatSession";
import { ChatSessionManager } from "@ask/lib/ChatSessionManager";
import { ChatTurn } from "@ask/lib/ChatTurn";
import type {
    AIChatOptions,
    AIChatSelection,
    ChatResponse,
    DetectedProvider,
    ModelInfo,
    SendOptions,
} from "@ask/lib/types";
import { modelSelector } from "@ask/providers/ModelSelector";
import { providerManager } from "@ask/providers/ProviderManager";
import type { ChatConfig } from "@ask/types";
import { getLanguageModel } from "@ask/types";
import type { ToolSet } from "ai";
import { tool } from "ai";

interface EngineWithRestore {
    engine: ChatEngine;
    restore: () => void;
}

const DEFAULT_SESSION_DIR = resolve(homedir(), ".genesis-tools/ai-chat/sessions");

export class AIChat {
    private _options: AIChatOptions;
    private _engine: ChatEngine | null = null;
    private _initPromise: Promise<void> | null = null;
    private _activeTurn: ChatTurn | null = null;
    private _sessionManager: ChatSessionManager | null = null;
    private _resolvedTools: ToolSet | undefined;

    readonly session: ChatSession;
    readonly log: ChatLog;

    constructor(options: AIChatOptions) {
        if (options.resume && options.session?.id && options.resume !== options.session.id) {
            throw new Error(
                `Conflicting session IDs: resume="${options.resume}" vs session.id="${options.session.id}". Use only one.`
            );
        }

        this._options = { ...options };
        this.log = new ChatLog(options.logLevel ?? "info");

        // Set up session
        if (options.session || options.resume) {
            const dir = options.session?.dir ?? DEFAULT_SESSION_DIR;
            this._sessionManager = new ChatSessionManager({ dir });

            const sessionId = options.resume ?? options.session?.id ?? crypto.randomUUID();
            this.session = this._sessionManager.create(sessionId);
        } else {
            this.session = new ChatSession(crypto.randomUUID());
        }
    }

    /** Ensure provider/model are resolved and engine is created */
    async initialize(): Promise<void> {
        return this._ensureInitialized();
    }

    private async _ensureInitialized(): Promise<void> {
        if (this._engine) {
            return;
        }

        if (this._initPromise) {
            return this._initPromise;
        }

        this._initPromise = this._initialize();
        return this._initPromise;
    }

    private async _initialize(): Promise<void> {
        // If resuming, load the session first
        if (this._options.resume && this._sessionManager) {
            try {
                await this.session.load(this._options.resume);
            } catch {
                // Session doesn't exist yet — that's fine, start fresh
                this.log.createLogger("AIChat").info(`No existing session "${this._options.resume}", starting fresh`);
            }
        }

        // Resolve provider and model
        const choice = await modelSelector.selectModelByName(this._options.provider, this._options.model);

        if (!choice) {
            throw new Error(
                `Could not resolve provider "${this._options.provider}" / model "${this._options.model}". ` +
                    `Check that the API key is configured and the model ID is valid.`
            );
        }

        // Create ChatEngine — providerChoice enables automatic system prompt prefix
        const languageModel = getLanguageModel(choice.provider.provider, choice.model.id, choice.provider.type);
        const config: ChatConfig = {
            model: languageModel,
            provider: choice.provider.name,
            modelName: choice.model.id,
            streaming: true,
            systemPrompt: this._options.systemPrompt,
            temperature: this._options.temperature,
            maxTokens: this._options.maxTokens,
            providerChoice: choice,
            providerType: choice.provider.type,
        };

        this._engine = new ChatEngine(config);

        // Resolve tools from AIChatTool format to AI SDK ToolSet
        if (this._options.tools && Object.keys(this._options.tools).length > 0) {
            this._resolvedTools = {};

            for (const [name, t] of Object.entries(this._options.tools)) {
                this._resolvedTools[name] = tool({
                    description: t.description,
                    inputSchema: t.parameters as Parameters<typeof tool>[0]["inputSchema"],
                    execute: t.execute,
                });
            }
        }

        // Add config entry to session
        this.session.addConfig(choice.provider.name, choice.model.id, this._options.systemPrompt);
    }

    /**
     * Send a message — returns a ChatTurn that is both awaitable and streamable.
     *
     * @example
     * // Buffered
     * const response = await chat.send("Hello!");
     *
     * // Streaming
     * for await (const event of chat.send("Tell me a story")) {
     *   if (event.isText()) process.stdout.write(event.text);
     * }
     */
    send(message: string, options?: SendOptions): ChatTurn {
        const addToHistory = options?.addToHistory !== false;
        const saveThinking = options?.saveThinking ?? false;

        const source = () => this._generateEvents(message, options, addToHistory, saveThinking);
        const turn = new ChatTurn(source, options?.onChunk);

        this._activeTurn = turn;
        return turn;
    }

    private async *_generateEvents(
        message: string,
        options: SendOptions | undefined,
        addToHistory: boolean,
        saveThinking: boolean
    ): AsyncGenerator<ChatEvent> {
        await this._ensureInitialized();

        const { engine, restore } = this._getEngine(options?.override);

        // Add user message to session
        if (addToHistory) {
            this.session.add({ role: "user", content: message });
        }

        // Build messages from session history
        const messages = this.session.toMessages();

        // Rebuild system prompt each call to include any new system/context entries
        // added between send() calls. This is intentional — the session may have
        // new context entries that should be included in the prompt.
        const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content);
        const systemPrompt = [this._options.systemPrompt, ...systemMessages].filter(Boolean).join("\n\n");

        if (systemPrompt) {
            engine.setSystemPrompt(systemPrompt);
        }

        // Track chunks for building response
        let fullContent = "";
        let thinkingContent = "";
        const startTime = Date.now();

        // Bridge push-based onChunk to pull-based async generator via ReadableStream
        const stream = new ReadableStream<ChatEvent>({
            start: async (controller) => {
                try {
                    const engineResponse = await engine.sendMessage(message, this._resolvedTools, {
                        onChunk: (chunk: string) => {
                            controller.enqueue(ChatEvent.text(chunk));
                            fullContent += chunk;
                        },
                        onThinking: (text: string) => {
                            controller.enqueue(ChatEvent.thinking(text));
                            thinkingContent += text;
                        },
                        onToolCall: (name: string, input: unknown) => {
                            controller.enqueue(ChatEvent.toolCall(name, input));
                        },
                        onToolResult: (name: string, output: unknown) => {
                            controller.enqueue(ChatEvent.toolResult(name, output, 0));
                        },
                    });

                    const duration = Date.now() - startTime;
                    const response: ChatResponse = {
                        content: fullContent || engineResponse.content,
                        thinking: thinkingContent || undefined,
                        usage: engineResponse.usage
                            ? {
                                  inputTokens: engineResponse.usage.inputTokens ?? 0,
                                  outputTokens: engineResponse.usage.outputTokens ?? 0,
                                  totalTokens: engineResponse.usage.totalTokens ?? 0,
                                  cachedInputTokens: engineResponse.usage.cachedInputTokens ?? undefined,
                              }
                            : undefined,
                        cost: engineResponse.cost,
                        duration,
                    };

                    if (addToHistory) {
                        this.session.add({
                            role: "assistant",
                            content: response.content,
                            thinking: saveThinking ? thinkingContent : undefined,
                            usage: response.usage,
                            cost: engineResponse.cost,
                        });
                    }

                    if (this._options.session?.autoSave && this._sessionManager) {
                        await this.session.save();
                    }

                    controller.enqueue(ChatEvent.done(response));
                } catch (error) {
                    controller.error(error);
                } finally {
                    controller.close();
                }
            },
        });

        const reader = stream.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                yield value;
            }
        } finally {
            reader.releaseLock();
            restore();
        }
    }

    /** Get a ChatEngine instance with optional per-call overrides.
     * Returns a restore function that resets the engine to its previous state.
     */
    private _getEngine(override?: SendOptions["override"]): EngineWithRestore {
        if (!this._engine) {
            throw new Error("AIChat not initialized");
        }

        if (!override) {
            return { engine: this._engine, restore: () => {} };
        }

        const saved = this._engine.getConfig();

        if (override.temperature !== undefined) {
            this._engine.setTemperature(override.temperature);
        }

        if (override.maxTokens !== undefined) {
            this._engine.setMaxTokens(override.maxTokens);
        }

        if (override.systemPrompt !== undefined) {
            this._engine.setSystemPrompt(override.systemPrompt);
        }

        return {
            engine: this._engine,
            restore: () => {
                this._engine?.setTemperature(saved.temperature ?? 0.7);
                this._engine?.setMaxTokens(saved.maxTokens ?? 4096);
                if (saved.systemPrompt !== undefined) {
                    this._engine?.setSystemPrompt(saved.systemPrompt);
                }
            },
        };
    }

    /**
     * Stream events from the most recent send() call.
     */
    stream(): AsyncIterable<ChatEvent> {
        if (!this._activeTurn) {
            throw new Error("No active turn — call send() first");
        }

        return this._activeTurn;
    }

    /** Update config */
    updateConfig(options: Partial<Omit<AIChatOptions, "session" | "resume">>): void {
        this._options = { ...this._options, ...options };

        // Reset engine so it gets recreated with new config on next send()
        if (options.provider || options.model) {
            this._engine = null;
            this._initPromise = null;
        }

        if (this._engine) {
            if (options.temperature !== undefined) {
                this._engine.setTemperature(options.temperature);
            }

            if (options.maxTokens !== undefined) {
                this._engine.setMaxTokens(options.maxTokens);
            }

            if (options.systemPrompt !== undefined) {
                this._engine.setSystemPrompt(options.systemPrompt);
            }
        }

        if (options.logLevel) {
            // ChatLog doesn't support changing level after creation, so create a new one
            // But since log is readonly, we'd need to handle this differently
            // For now, logLevel is set at construction time only
        }
    }

    getConfig(): Readonly<AIChatOptions> {
        return { ...this._options };
    }

    /** Get the account that was resolved for this chat session (if any). */
    getResolvedAccount(): { name: string; label?: string } | undefined {
        return this._engine?.getConfig().providerChoice?.provider.account;
    }

    /** Save session and release resources */
    async dispose(): Promise<void> {
        if (this._options.session?.autoSave && this._sessionManager) {
            await this.session.save();
        }
    }

    // === Static Methods ===

    /**
     * Get available providers (filtered by configured API keys)
     */
    static async getProviders(filter?: { capabilities?: string[] }): Promise<DetectedProvider[]> {
        const providers = await providerManager.detectProviders();
        const caps = filter?.capabilities;

        if (!caps?.length) {
            return providers;
        }

        return providers.filter((p) => p.models.some((m) => caps.every((cap) => m.capabilities.includes(cap))));
    }

    /**
     * Get models for a specific provider
     */
    static async getModels(options: { provider: string; capabilities?: string[] }): Promise<ModelInfo[]> {
        await providerManager.detectProviders();
        let models = await providerManager.getModelsForProvider(options.provider);
        const caps = options.capabilities;

        if (caps?.length) {
            models = models.filter((m) => caps.every((cap) => m.capabilities.includes(cap)));
        }

        return models;
    }

    /**
     * Interactive provider selection (clack prompts)
     */
    static async selectProviderInteractively(): Promise<DetectedProvider | null> {
        const providers = await providerManager.detectProviders();
        return modelSelector.selectProvider(providers);
    }

    /**
     * Interactive model selection — returns object that spreads into constructor
     */
    static async selectModelInteractively(_options?: {
        providers?: DetectedProvider[];
    }): Promise<AIChatSelection | null> {
        const choice = await modelSelector.selectModel();

        if (!choice) {
            return null;
        }

        return {
            provider: choice.provider.name,
            model: choice.model.id,
        };
    }
}
