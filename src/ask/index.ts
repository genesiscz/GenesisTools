#!/usr/bin/env bun

import logger from "@app/logger";
import { input } from "@app/utils/prompts/clack";
import { handleReadmeFlag } from "@app/utils/readme";
import { AIChat } from "@ask/AIChat";
import { transcriptionManager } from "@ask/audio/TranscriptionManager";
import { ChatEngine } from "@ask/chat/ChatEngine";
import type { CommandResult } from "@ask/chat/CommandHandler";
import { commandHandler } from "@ask/chat/CommandHandler";
import { conversationManager } from "@ask/chat/ConversationManager";
import { costPredictor } from "@ask/output/CostPredictor";
import { costTracker } from "@ask/output/CostTracker";
import { outputManager } from "@ask/output/OutputManager";
import { modelSelector } from "@ask/providers/ModelSelector";
import { getLanguageModel } from "@ask/types";
import { webSearchTool } from "@ask/utils/websearch";
import * as p from "@clack/prompts";
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
import { colorizeProvider, generateSessionId } from "@ask/utils/helpers";

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

            // Handle models subcommand
            const firstArg = argv._[0]?.toLowerCase();
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
        const message = argv._.join(" ");
        if (!message) {
            logger.error("No message provided");
            process.exit(1);
        }

        try {
            // Use AIChat — no stdout monkey-patching needed
            if (!argv.provider || !argv.model) {
                logger.error("Provider (-p) and model (-m) are required for non-interactive mode");
                process.exit(1);
            }

            const chat = new AIChat({
                provider: argv.provider,
                model: argv.model,
                systemPrompt: createSystemPrompt(argv.systemPrompt),
                temperature: parseTemperature(argv.temperature),
                maxTokens: parseMaxTokens(argv.maxTokens),
                logLevel: argv.raw ? "silent" : "info",
            });

            if (argv.raw) {
                // Raw mode: buffered response, only output content
                const response = await chat.send(message);
                process.stdout.write(response.content.endsWith("\n") ? response.content : `${response.content}\n`);
                return;
            }

            // Streaming mode with UI
            // We still need provider/model info for display, so resolve first
            const config = chat.getConfig();
            p.log.info(`Using ${colorizeProvider(config.provider)}/${config.model}`);

            // Optional: Show cost prediction if --predict-cost flag is set
            if (argv.predictCost) {
                const modelChoice = await modelSelector.selectModelByName(argv.provider, argv.model);

                if (modelChoice) {
                    const prediction = await costPredictor.predictCost(
                        modelChoice.provider.name,
                        modelChoice.model.id,
                        message,
                    );
                    p.log.info(pc.cyan(costPredictor.formatPrediction(prediction)));
                }
            }

            p.log.step(pc.yellow("Thinking..."));

            // Stream the response
            for await (const event of chat.send(message)) {
                if (event.isText()) {
                    process.stdout.write(event.text);
                }

                if (event.isDone()) {
                    process.stdout.write("\n");
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
                            0,
                        );
                    }

                    // Handle output
                    const outputConfig = getOutputFormat(argv);
                    await outputManager.handleOutput(response.content, outputConfig, {
                        provider: config.provider,
                        model: config.model,
                        cost: response.cost,
                        usage: response.usage,
                    });

                    // Show cost breakdown
                    if (response.cost && response.cost > 0) {
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

                        console.log(await outputManager.formatCostBreakdown(breakdown));
                    }
                }
            }
        } catch (error) {
            logger.error(`Chat failed: ${error}`);
            throw error;
        }
    }

    private async startInteractiveChat(argv: Args): Promise<void> {
        if (process.stdout.isTTY) {
            p.intro(pc.bgCyan(pc.black(" ASK ")));
        }

        p.log.info(pc.dim("Type /help for available commands, /quit to exit"));

        // Select initial model
        const modelChoice = await modelSelector.selectModel();
        if (!modelChoice) {
            logger.error("No model selected. Exiting.");
            process.exit(1);
        }

        p.log.step(`Starting with ${colorizeProvider(modelChoice.provider.name)}/${modelChoice.model.name}`);

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
                    const result = await commandHandler.handleCommand(
                        msg,
                        modelChoice.provider.name,
                        modelChoice.model.id
                    );

                    if (result.shouldExit) {
                        shouldExit = true;
                        break;
                    }

                    // Handle command results
                    await this.handleCommandResult(result, chatEngine, modelChoice, chatConfig);
                    continue;
                }

                // Regular chat message
                console.log(pc.yellow("\nAssistant:"));

                // Set up tools
                const tools = this.getAvailableTools();

                const startTime = Date.now();

                // Send message
                const response = await chatEngine.sendMessage(msg, tools);

                const duration = Date.now() - startTime;

                // Show timing info
                console.log(pc.dim(`\nResponse time: ${formatElapsedTime(duration)}`));

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

                    console.log(await outputManager.formatCostBreakdown(breakdown));
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
        p.log.info(pc.dim(`Session saved: ${sessionId}`));
        p.log.info(pc.dim(`Messages: ${session.messages.length}`));
        p.log.info(pc.dim(`Duration: ${formatElapsedTime(Date.now() - new Date(session.startTime).getTime())}`));

        if (process.stdout.isTTY) {
            p.outro(pc.green("Goodbye!"));
        } else {
            console.log("Goodbye!");
        }
    }

    private async createChatConfig(modelChoice: ProviderChoice, argv: CLIOptions): Promise<ChatConfig> {
        const model = getLanguageModel(modelChoice.provider.provider, modelChoice.model.id);

        return {
            model,
            provider: modelChoice.provider.name,
            modelName: modelChoice.model.id,
            streaming: argv.streaming !== false, // Default to true
            systemPrompt: createSystemPrompt(argv.systemPrompt),
            temperature: parseTemperature(argv.temperature),
            maxTokens: parseMaxTokens(argv.maxTokens),
        };
    }

    private getAvailableTools():
        | Record<
              string,
              {
                  description: string;
                  parameters: {
                      [key: string]: {
                          type: string;
                          description: string;
                          optional?: boolean;
                      };
                  };
                  execute: (...args: unknown[]) => Promise<unknown>;
              }
          >
        | undefined {
        const tools: Record<
            string,
            {
                description: string;
                parameters: {
                    [key: string]: {
                        type: string;
                        description: string;
                        optional?: boolean;
                    };
                };
                execute: (...args: unknown[]) => Promise<unknown>;
            }
        > = {};

        // Add web search if available
        const searchTool = webSearchTool.createSearchTool();
        if (searchTool) {
            tools.searchWeb = {
                description: searchTool.description,
                parameters: searchTool.parameters,
                execute: async (...args: unknown[]) => {
                    const params = args[0] as Parameters<typeof searchTool.execute>[0];
                    return await searchTool.execute(params);
                },
            };
        }

        return Object.keys(tools).length > 0 ? tools : undefined;
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
            }
            if (result.newModelName) {
                modelChoice.model.id = result.newModelName;
            }
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
