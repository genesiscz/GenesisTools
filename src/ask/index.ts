#!/usr/bin/env bun

import logger from "@app/logger";
import { transcriptionManager } from "@app/utils/ai/transcription/TranscriptionManager";
import { input } from "@app/utils/prompts/clack";
import { handleReadmeFlag } from "@app/utils/readme";
import { AIChat } from "@ask/AIChat";
import { ChatEngine } from "@ask/chat/ChatEngine";
import type { ChatState, CommandResult } from "@ask/chat/CommandHandler";
import { commandHandler } from "@ask/chat/CommandHandler";
import { conversationManager } from "@ask/chat/ConversationManager";
import { loadAskContext } from "@ask/lib/context-loader";
import { AskStreamRenderer } from "@ask/output/AskStreamRenderer";
import { askUI, initAskUI } from "@ask/output/AskUILogger";
import { costPredictor } from "@ask/output/CostPredictor";
import { costTracker } from "@ask/output/CostTracker";
import { outputManager } from "@ask/output/OutputManager";
import { modelSelector } from "@ask/providers/ModelSelector";
import { getFileTools } from "@ask/tools/file-tools";
import { getLanguageModel } from "@ask/types";
import { expandAtMentions } from "@ask/utils/at-mentions";
import { webSearchTool } from "@ask/utils/websearch";
import * as p from "@clack/prompts";
import type { ToolSet } from "ai";
import { tool } from "ai";
import pc from "picocolors";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

import { showPricing } from "@ask/pricing/index";
import type { Args, ChatConfig, CLIOptions, ProviderChoice } from "@ask/types";
import type { ModelsOptions } from "@ask/types/cli";
import {
    createSystemPrompt,
    formatElapsedTime,
    formatError,
    getOutputFormat,
    isInteractiveMode,
    parseCLIArguments,
    parseMaxTokens,
    parseTemperature,
    shouldShowHelp,
    shouldShowVersion,
    showHelp,
    showVersion,
    validateOptions,
} from "@ask/utils/cli";
import { generateSessionId } from "@ask/utils/helpers";

// Initialize conversation manager
const convManager = conversationManager;

class ASKTool {
    async main(): Promise<void> {
        try {
            const argv = parseCLIArguments();

            // Handle help and version
            if (shouldShowHelp(argv)) {
                showHelp();
                process.exit(0);
            }

            if (shouldShowVersion(argv)) {
                showVersion();
                process.exit(0);
            }

            // Handle subcommands
            const firstArg = argv._[0]?.toLowerCase();

            // Configure command
            if (firstArg === "configure" || firstArg === "config") {
                const { runConfigureWizard } = await import("@ask/commands/configure");
                await runConfigureWizard();
                return;
            }

            if (firstArg === "models" || firstArg === "model") {
                const modelsOptions: ModelsOptions = {
                    provider: argv.provider,
                    format: argv.format as ModelsOptions["format"],
                    sort: argv.sort as ModelsOptions["sort"],
                    filterCapabilities: argv.filterCapabilities,
                };
                await showPricing(modelsOptions);
                return;
            }

            // Apply config defaults from unified AIConfig
            const { AIConfig } = await import("@app/utils/ai/AIConfig");
            const aiConfig = await AIConfig.load();
            const askDefaults = aiConfig.getAppDefaults("ask");

            if (!argv.provider && askDefaults?.provider) {
                argv.provider = askDefaults.provider;
            }

            if (!argv.model && askDefaults?.model) {
                argv.model = askDefaults.model;
            }

            // Fuzzy model matching: resolve partial model names
            const originalModel = argv.model;
            let fuzzyResolved = false;

            if (argv.model) {
                const resolved = await this.resolveModelFuzzy(argv.model, argv.provider);
                if (resolved) {
                    argv.provider = resolved.provider;
                    argv.model = resolved.model;
                    fuzzyResolved = true;
                } else {
                    // Partial model name didn't resolve — clear it so interactive selector or
                    // non-TTY guard handles it properly instead of passing garbage to AIChat
                    argv.model = undefined;
                }
            }

            this.toolsDisabled = !!argv.noTools;

            initAskUI({
                isTTY: process.stdout.isTTY ?? false,
                modelPreSelected: !!argv.model,
                raw: !!argv.raw,
                silent: !!argv.silent,
                showCost: !!argv.cost,
                outputFormat: argv.output ? "file" : argv.format,
            });

            // Non-TTY guard: require provider/model when stdin is piped
            const isTTY = process.stdin.isTTY ?? false;

            if (!isTTY) {
                // Read message from stdin if no positional args
                if (argv._.length === 0 && !argv.sst && !argv.interactive) {
                    const stdinText = await new Response(Bun.stdin.stream()).text();
                    const trimmed = stdinText.trim();

                    if (!trimmed) {
                        this.exitWithUsageHint("No message provided in non-interactive mode.");
                    }

                    argv._.push(trimmed);
                }

                const hasMessage = argv._.length > 0;

                if (!hasMessage && !argv.sst && !argv.interactive) {
                    this.exitWithUsageHint("No message provided in non-interactive mode.");
                }

                // Model was given but didn't resolve to a known model
                if (hasMessage && originalModel && !fuzzyResolved) {
                    await this.exitWithModelHint(argv.provider, originalModel);
                }

                if (hasMessage && (!argv.provider || !argv.model)) {
                    await this.exitWithModelHint(argv.provider, argv.model);
                }

                if (argv.interactive) {
                    this.exitWithUsageHint("Interactive mode (-i) requires a TTY terminal.");
                }
            }

            // Validate options
            const validation = validateOptions(argv);
            if (!validation.valid) {
                logger.error("Invalid options:");
                for (const error of validation.errors) {
                    logger.error(`  - ${error}`);
                }
                process.exit(1);
            }

            // Handle speech-to-text
            if (argv.sst) {
                await this.handleSpeechToText(argv.sst, argv);
                return;
            }

            // Handle single message vs interactive mode
            const interactive = isInteractiveMode(argv, argv);

            if (!isTTY && interactive) {
                this.exitWithUsageHint("No message provided in non-interactive mode.");
            }

            if (interactive) {
                await this.startInteractiveChat(argv);
            } else {
                await this.handleSingleMessage(argv);
            }
        } catch (error) {
            logger.error(`ASK tool failed: ${formatError(error)}`);
            process.exit(1);
        }
    }

    private suggestCommand(provider: string, model: string): void {
        const cmd = `tools ask -p ${provider} -m ${model} "your message"`;
        p.log.info(pc.dim(`Non-interactive: ${cmd}`));
    }

    private exitWithUsageHint(reason: string): never {
        console.error(pc.red(reason));
        console.error("");
        console.error(pc.dim("Usage examples:"));
        console.error(pc.dim(`  tools ask -p anthropic -m claude-sonnet-4-20250514 "your message"`));
        console.error(pc.dim(`  tools ask -p openai -m gpt-4o "your message"`));
        console.error(pc.dim(`  echo "your message" | tools ask -p anthropic -m claude-sonnet-4-20250514`));
        console.error("");
        console.error(pc.dim("Configure defaults:  tools ask config"));
        console.error(pc.dim("List providers:      tools ask models"));
        process.exit(1);
    }

    private async exitWithModelHint(provider?: string, model?: string): Promise<never> {
        const missing = !provider && !model ? "provider and model" : !provider ? "provider (-p)" : "model (-m)";
        console.error(pc.red(`Missing ${missing} for non-interactive mode.`));

        // Show fuzzy matches if partial model was given
        if (model) {
            // First try scoped to provider, then fallback to all providers
            let { matches } = await modelSelector.fuzzyMatchModel(model, provider);

            if (matches.length === 0 && provider) {
                ({ matches } = await modelSelector.fuzzyMatchModel(model));
            }

            if (matches.length > 0) {
                console.error("");
                console.error(pc.yellow("Did you mean one of these?"));
                for (const m of matches.slice(0, 8)) {
                    console.error(pc.dim(`  tools ask -p ${m.provider.name} -m ${m.model.id} "your message"`));
                }
            }
        }

        // Show available providers
        const { providerManager: pm } = await import("@ask/providers/ProviderManager");
        const providers = await pm.detectProviders();

        if (providers.length > 0) {
            console.error("");
            console.error(pc.dim("Available providers:"));
            for (const prov of providers) {
                const topModels = prov.models.slice(0, 3).map((m) => m.id);
                const suffix = prov.models.length > 3 ? ` +${prov.models.length - 3} more` : "";
                console.error(pc.dim(`  ${prov.name}: ${topModels.join(", ")}${suffix}`));
            }
        }

        console.error("");
        console.error(pc.dim("Configure defaults:  tools ask config"));
        process.exit(1);
    }

    private async resolveModelFuzzy(
        query: string,
        providerName?: string
    ): Promise<{ provider: string; model: string } | null> {
        // Try scoped to provider first
        const scoped = await modelSelector.fuzzyMatchModel(query, providerName);

        // Exact match → always auto-select (user typed the full model ID)
        if (scoped.exact) {
            const match = scoped.matches[0];
            return { provider: match.provider.name, model: match.model.id };
        }

        // If scoped search failed, try globally (e.g., user passed -m gpt-4o with default provider anthropic)
        let allMatches = scoped.matches;

        if (providerName && allMatches.length === 0) {
            const global = await modelSelector.fuzzyMatchModel(query);

            if (global.exact) {
                const match = global.matches[0];
                return { provider: match.provider.name, model: match.model.id };
            }

            allMatches = global.matches;
        }

        if (allMatches.length === 0) {
            return null;
        }

        // Non-TTY: auto-select if unique, otherwise fail (exitWithModelHint handles suggestions)
        if (!(process.stdout.isTTY ?? false)) {
            if (allMatches.length === 1) {
                const match = allMatches[0];
                return { provider: match.provider.name, model: match.model.id };
            }

            return null;
        }

        // TTY: always show interactive picker for fuzzy matches so user confirms the choice
        const choice = await p.select({
            message: `"${query}" matches ${allMatches.length} model${allMatches.length > 1 ? "s" : ""}:`,
            options: allMatches.slice(0, 15).map((m) => ({
                value: m,
                label: `${m.provider.name}/${m.model.id}`,
                hint: m.model.name !== m.model.id ? m.model.name : undefined,
            })),
        });

        if (p.isCancel(choice)) {
            return null;
        }

        const selected = choice as (typeof allMatches)[0];
        return { provider: selected.provider.name, model: selected.model.id };
    }

    private async handleSpeechToText(filePath: string, argv: Args): Promise<void> {
        try {
            p.log.step(pc.blue("Transcribing audio..."));

            const result = await transcriptionManager.transcribeAudio(filePath);

            const outputConfig = getOutputFormat(argv);

            await outputManager.handleOutput(result.text, outputConfig, {
                provider: result.provider,
                model: result.model,
                processingTime: result.processingTime,
            });

            p.log.success(`Transcription completed in ${formatElapsedTime(result.processingTime)}`);
        } catch (error) {
            logger.error(`Speech-to-text failed: ${error}`);
            throw error;
        }
    }

    private async handleSingleMessage(argv: Args): Promise<void> {
        const rawMessage = argv._.join(" ");
        if (!rawMessage) {
            logger.error("No message provided");
            process.exit(1);
        }

        // Expand @file mentions
        const { text: message, mentions } = expandAtMentions(rawMessage);

        if (mentions.length > 0) {
            const files = mentions.map((m) => m.path);
            p.log.info(pc.dim(`Attached ${files.length} file${files.length > 1 ? "s" : ""}: ${files.join(", ")}`));
        }

        try {
            // Resolve provider/model if not specified — prompt in TTY, error in non-TTY
            if (!argv.provider || !argv.model) {
                if (process.stdout.isTTY) {
                    askUI().intro();

                    const modelChoice = await modelSelector.selectModel();
                    if (!modelChoice) {
                        logger.error("No model selected. Exiting.");
                        process.exit(1);
                    }

                    argv.provider = modelChoice.provider.name;
                    argv.model = modelChoice.model.id;
                    this.suggestCommand(argv.provider, argv.model);
                } else {
                    logger.error("Provider (-p) and model (-m) are required for non-interactive mode");
                    process.exit(1);
                }
            }

            const baseSystem = createSystemPrompt(argv.systemPrompt);
            const contextBlock = argv.noContext ? undefined : await loadAskContext(process.cwd(), 4000);
            const combinedSystem = [baseSystem, contextBlock].filter(Boolean).join("\n\n") || undefined;

            const chat = new AIChat({
                provider: argv.provider,
                model: argv.model,
                systemPrompt: combinedSystem,
                temperature: parseTemperature(argv.temperature),
                maxTokens: parseMaxTokens(argv.maxTokens),
                logLevel: argv.raw ? "silent" : "info",
                tools: this.getAIChatTools(),
            });

            if (argv.raw) {
                // Raw mode: buffered response, only output content
                const response = await chat.send(message);
                process.stdout.write(response.content.endsWith("\n") ? response.content : `${response.content}\n`);
                return;
            }

            // Streaming mode with UI — initialize first so resolved account is available
            await chat.initialize();
            const config = chat.getConfig();
            askUI().logUsing({ provider: config.provider, model: config.model, account: chat.getResolvedAccount() });

            // Optional: Show cost prediction if --predict-cost flag is set
            if (argv.predictCost) {
                const modelChoice = await modelSelector.selectModelByName(argv.provider, argv.model);

                if (modelChoice) {
                    const prediction = await costPredictor.predictCost(
                        modelChoice.provider.name,
                        modelChoice.model.id,
                        message
                    );
                    p.log.info(pc.cyan(costPredictor.formatPrediction(prediction)));
                }
            }

            askUI().logThinking();

            // Suppress streaming text for non-text output formats (json, jsonl, markdown, clipboard, file)
            // — handleOutput will print the final content in the correct format
            const outputConfig = getOutputFormat(argv);
            const suppressStreaming = outputConfig?.type != null && outputConfig.type !== "text";

            const streamRenderer = suppressStreaming ? null : new AskStreamRenderer();

            // Stream the response
            for await (const event of chat.send(message)) {
                if (streamRenderer) {
                    streamRenderer.renderEvent(event);
                }

                if (event.isDone()) {
                    const response = event.response;

                    // Track usage
                    if (response.usage) {
                        const sessionId = generateSessionId();
                        await costTracker.trackUsage(
                            config.provider,
                            config.model,
                            {
                                inputTokens: response.usage.inputTokens,
                                outputTokens: response.usage.outputTokens,
                                totalTokens: response.usage.totalTokens,
                                cachedInputTokens: response.usage.cachedInputTokens,
                            },
                            sessionId,
                            0
                        );
                    }

                    // Handle non-text output (file, clipboard, json, jsonl)
                    if (outputConfig?.type && outputConfig.type !== "text") {
                        await outputManager.handleOutput(response.content, outputConfig);
                    }

                    // Show cost breakdown (TTY always, non-TTY only with --cost)
                    const showCost = askUI().shouldShowCost();
                    if (showCost && response.cost && response.cost > 0) {
                        const breakdown = [
                            {
                                provider: config.provider,
                                model: config.model,
                                inputTokens: response.usage?.inputTokens || 0,
                                outputTokens: response.usage?.outputTokens || 0,
                                cachedInputTokens: response.usage?.cachedInputTokens || 0,
                                totalTokens: response.usage?.totalTokens || 0,
                                cost: response.cost,
                                currency: "USD",
                            },
                        ];

                        console.log(await outputManager.formatCostBreakdown(breakdown, chat.getResolvedAccount()));
                    }
                }
            }
        } catch (error) {
            logger.error(`Chat failed: ${error}`);
            throw error;
        }
    }

    private async startInteractiveChat(argv: Args): Promise<void> {
        askUI().intro();
        p.log.info(pc.dim("Type /help for available commands, /quit to exit"));

        // Select initial model
        const modelChoice = await modelSelector.selectModel();
        if (!modelChoice) {
            logger.error("No model selected. Exiting.");
            process.exit(1);
        }

        askUI().logStarting({ provider: modelChoice.provider.name, model: modelChoice.model.name });

        this.suggestCommand(modelChoice.provider.name, modelChoice.model.id);

        // Create chat config
        const chatConfig = await this.createChatConfig(modelChoice, argv);

        // Create chat engine
        const chatEngine = new ChatEngine(chatConfig);

        // Create session
        const sessionId = generateSessionId();
        const session = convManager.createSession(sessionId, modelChoice.provider.name, modelChoice.model.id);

        // Set output format (support both --output and --format)
        const outputConfig = getOutputFormat(argv);
        if (outputConfig) {
            outputManager.setOutputFormat(outputConfig);
        }

        let shouldExit = false;
        let lastCancelTime = 0;

        while (!shouldExit) {
            try {
                // Get user input
                const message = await input({
                    message: pc.cyan("You:"),
                    mode: "light",
                    validate: (value) => {
                        if (value.startsWith("/")) {
                            return commandHandler.isValidCommand(value)
                                ? undefined
                                : "Unknown command. Type /help for available commands.";
                        }
                        return value.trim().length > 0 ? undefined : "Please enter a message or command.";
                    },
                });

                if (p.isCancel(message) || typeof message === "symbol") {
                    const now = Date.now();
                    if (now - lastCancelTime < 2000) {
                        shouldExit = true;
                        break;
                    }
                    lastCancelTime = now;
                    p.log.warn(pc.dim("Press Ctrl+C again to quit."));
                    continue;
                }

                const msg = message as string;

                // Handle special commands
                if (msg.startsWith("/")) {
                    const availableTools = this.getAvailableTools();
                    const chatState: ChatState = {
                        systemPrompt: this.rawSystemPrompt,
                        conversationLength: chatEngine.getConversationLength(),
                        totalTokens: chatEngine.getTotalTokens(),
                        toolNames: availableTools ? Object.keys(availableTools) : [],
                        contextBlock: chatConfig.systemPrompt,
                    };

                    const result = await commandHandler.handleCommand(
                        msg,
                        modelChoice.provider.name,
                        modelChoice.model.id,
                        chatState
                    );

                    if (result.shouldExit) {
                        shouldExit = true;
                        break;
                    }

                    // Handle command results
                    await this.handleCommandResult(result, chatEngine, modelChoice, chatConfig);
                    continue;
                }

                // Expand @file mentions in the message
                const { text: expandedMsg, mentions: msgMentions } = expandAtMentions(msg);

                if (msgMentions.length > 0) {
                    const files = msgMentions.map((m) => m.path);
                    p.log.info(
                        pc.dim(`Attached ${files.length} file${files.length > 1 ? "s" : ""}: ${files.join(", ")}`)
                    );
                }

                // Regular chat message
                console.log(pc.yellow("\nAssistant:"));

                // Set up tools
                const tools = this.getAvailableTools();

                const startTime = Date.now();

                const interactiveRenderer = new AskStreamRenderer();

                // Send message with tool callbacks
                const response = await chatEngine.sendMessage(expandedMsg, tools, {
                    onToolCall: (name, args) => {
                        interactiveRenderer.renderToolCall(name, args);
                    },
                    onToolResult: (name, result) => {
                        interactiveRenderer.renderToolResult(name, result);
                    },
                });

                const duration = Date.now() - startTime;

                // Show timing info
                askUI().logResponseTime({ duration: formatElapsedTime(duration) });

                // Track usage
                if (response.usage) {
                    const messageIndex = Math.floor(chatEngine.getConversationLength() / 2);
                    await costTracker.trackUsage(
                        modelChoice.provider.name,
                        modelChoice.model.id,
                        response.usage,
                        sessionId,
                        messageIndex
                    );
                }

                // Auto-save conversation every 5 exchanges (10 messages)
                if (chatEngine.getConversationLength() % 10 === 0) {
                    session.messages = chatEngine.exportConversation();
                    await convManager.saveConversation(session);
                }

                // Show cost breakdown if significant
                if (response.cost && response.cost > 0.001) {
                    const breakdown = [
                        {
                            provider: modelChoice.provider.name,
                            model: modelChoice.model.id,
                            inputTokens: response.usage?.inputTokens || 0,
                            outputTokens: response.usage?.outputTokens || 0,
                            cachedInputTokens: response.usage?.cachedInputTokens || 0,
                            totalTokens: response.usage?.totalTokens || 0,
                            cost: response.cost,
                            currency: "USD",
                        },
                    ];

                    console.log(await outputManager.formatCostBreakdown(breakdown, modelChoice.provider.account));
                }

                console.log(); // Add spacing
            } catch (error) {
                logger.error(`Chat error: ${error}`);
                console.log(pc.red("Error occurred. Type /quit to exit or continue chatting."));
            }
        }

        // Save conversation before exiting
        session.messages = chatEngine.exportConversation();
        session.endTime = new Date().toISOString();
        await convManager.saveConversation(session);

        // Show session summary
        askUI().logSessionSummary({
            id: sessionId,
            messages: session.messages.length,
            duration: formatElapsedTime(Date.now() - new Date(session.startTime).getTime()),
        });

        askUI().outro();
    }

    private rawSystemPrompt = "";

    private async createChatConfig(modelChoice: ProviderChoice, argv: CLIOptions): Promise<ChatConfig> {
        const model = getLanguageModel(modelChoice.provider.provider, modelChoice.model.id, modelChoice.provider.type);
        const baseSystem = createSystemPrompt(argv.systemPrompt) ?? "";
        const contextBlock = argv.noContext ? undefined : await loadAskContext(process.cwd(), 4000);
        this.rawSystemPrompt = [baseSystem, contextBlock].filter(Boolean).join("\n\n");

        return {
            model,
            provider: modelChoice.provider.name,
            modelName: modelChoice.model.id,
            streaming: argv.streaming !== false, // Default to true
            systemPrompt: this.rawSystemPrompt,
            temperature: parseTemperature(argv.temperature),
            maxTokens: parseMaxTokens(argv.maxTokens),
            providerChoice: modelChoice,
            providerType: modelChoice.provider.type,
        };
    }

    private toolsDisabled = false;

    private getBaseToolRegistry() {
        if (this.toolsDisabled) {
            return null;
        }

        const fileTools = getFileTools();
        const searchToolDef = webSearchTool.createSearchTool();

        const registry: Record<string, ReturnType<typeof webSearchTool.createSearchTool>> = {};

        if (searchToolDef) {
            registry.searchWeb = searchToolDef;
        }

        return { fileTools, registry };
    }

    private getAvailableTools(): ToolSet | undefined {
        const base = this.getBaseToolRegistry();

        if (!base) {
            return undefined;
        }

        const tools: ToolSet = {
            ...base.fileTools,
        };

        if (base.registry.searchWeb) {
            tools.searchWeb = tool({
                description: base.registry.searchWeb.description,
                inputSchema: base.registry.searchWeb.parameters,
                execute: base.registry.searchWeb.execute,
            });
        }

        return Object.keys(tools).length > 0 ? tools : undefined;
    }

    /** Returns tools in AIChatTool format (for AIChat constructor). */
    private getAIChatTools():
        | Record<
              string,
              {
                  description: string;
                  parameters: unknown;
                  execute: (params: Record<string, unknown>) => Promise<unknown>;
              }
          >
        | undefined {
        const base = this.getBaseToolRegistry();

        if (!base) {
            return undefined;
        }

        const result: Record<
            string,
            {
                description: string;
                parameters: unknown;
                execute: (params: Record<string, unknown>) => Promise<unknown>;
            }
        > = {};

        // Add file tools (ai SDK Tool has inputSchema; AIChatTool expects parameters)
        for (const [name, t] of Object.entries(base.fileTools)) {
            result[name] = {
                description: t.description ?? "",
                parameters: t.inputSchema,
                execute: t.execute as (params: Record<string, unknown>) => Promise<unknown>,
            };
        }

        // Add web search
        if (base.registry.searchWeb) {
            result.searchWeb = {
                description: base.registry.searchWeb.description,
                parameters: base.registry.searchWeb.parameters,
                execute: base.registry.searchWeb.execute as (params: Record<string, unknown>) => Promise<unknown>,
            };
        }

        return Object.keys(result).length > 0 ? result : undefined;
    }

    private async handleCommandResult(
        result: CommandResult,
        chatEngine: ChatEngine,
        modelChoice: ProviderChoice,
        chatConfig: ChatConfig
    ): Promise<void> {
        if (result.newModel && result.newProvider) {
            await chatEngine.switchModel(result.newModel, result.newProvider, result.newModelName || "unknown");

            if (result.newProvider) {
                modelChoice.provider.name = result.newProvider;
                modelChoice.provider.systemPromptPrefix = result.newProviderChoice?.provider.systemPromptPrefix;
            }

            if (result.newModelName) {
                modelChoice.model.id = result.newModelName;
            }

            chatEngine.setSystemPrompt(this.rawSystemPrompt, result.newProviderChoice);
        }

        if (result.outputFormat) {
            outputManager.setOutputFormat(result.outputFormat);
        }

        if (result.clearHistory) {
            chatEngine.clearConversation();
            p.log.success("Conversation history cleared");
        }

        if (result.saveConversation) {
            const session = convManager.createSession(
                generateSessionId(),
                chatConfig.provider,
                chatConfig.modelName,
                chatEngine.exportConversation()
            );
            await convManager.saveConversation(session);
            p.log.success(`Conversation saved: ${session.id}`);
        }

        if (result.transcriptionFile) {
            try {
                p.log.step(pc.blue("Transcribing audio..."));
                const transcriptionResult = await transcriptionManager.transcribeAudio(result.transcriptionFile);

                await chatEngine.sendMessage(
                    `Transcription of "${result.transcriptionFile}":\n\n${transcriptionResult.text}`
                );

                p.log.success(`Transcription completed in ${formatElapsedTime(transcriptionResult.processingTime)}`);
            } catch (error) {
                logger.error(`Transcription failed: ${error}`);
            }
        }

        if (result.showHelp) {
            commandHandler.showHelp();
        }
    }
}

// Run the tool
const askTool = new ASKTool();
askTool.main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
