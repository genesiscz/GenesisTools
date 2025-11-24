#!/usr/bin/env bun

import Enquirer from "enquirer";
import chalk from "chalk";
import logger from "../logger";
import { ChatEngine } from "./chat/ChatEngine";
import { commandHandler } from "./chat/CommandHandler";
import type { CommandResult } from "./chat/CommandHandler";
import { ConversationManager, conversationManager } from "./chat/ConversationManager";
import { modelSelector } from "./providers/ModelSelector";
import { providerManager } from "./providers/ProviderManager";
import { transcriptionManager } from "./audio/TranscriptionManager";
import { outputManager } from "./output/OutputManager";
import { costTracker } from "./output/CostTracker";
import { costPredictor } from "./output/CostPredictor";
import { webSearchTool } from "./utils/websearch";
import {
    parseCLIArguments,
    showHelp,
    showVersion,
    validateOptions,
    formatError,
    isInteractiveMode,
    shouldShowHelp,
    shouldShowVersion,
    parseOutputFormat,
    createSystemPrompt,
    parseTemperature,
    parseMaxTokens,
    getConversationsDir,
    formatElapsedTime,
} from "./utils/cli";
import { generateSessionId, colorizeRole, colorizeProvider } from "./utils/helpers";
import type { Args, CLIOptions, ChatConfig, ProviderChoice } from "./types";

// Initialize conversation manager
const convManager = conversationManager;

class ASKTool {
    private prompter = new Enquirer();

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

            // Validate options
            const validation = validateOptions(argv);
            if (!validation.valid) {
                logger.error("Invalid options:");
                validation.errors.forEach((error) => logger.error(`  - ${error}`));
                process.exit(1);
            }

            // Handle speech-to-text
            if (argv.sst) {
                await this.handleSpeechToText(argv.sst, argv.output);
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

    private async handleSpeechToText(filePath: string, outputFormat?: string): Promise<void> {
        try {
            console.log(chalk.blue("<ï¿½ Transcribing audio..."));

            const result = await transcriptionManager.transcribeAudio(filePath);

            const outputConfig = outputFormat ? parseOutputFormat(outputFormat) : undefined;

            await outputManager.handleOutput(result.text, outputConfig, {
                provider: result.provider,
                model: result.model,
                processingTime: result.processingTime,
            });

            console.log(chalk.green(`\n Transcription completed in ${formatElapsedTime(result.processingTime)}`));
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
            // Determine provider and model
            const modelChoice = await modelSelector.selectModelByName(argv.provider, argv.model);
            if (!modelChoice) {
                logger.error("Failed to select model");
                process.exit(1);
            }

            console.log(chalk.blue(`> Using ${colorizeProvider(modelChoice.provider.name)}/${modelChoice.model.name}`));

            // Create chat config
            const chatConfig = await this.createChatConfig(modelChoice, argv);

            // Create chat engine
            const chatEngine = new ChatEngine(chatConfig);

            // Optional: Show cost prediction if --predict-cost flag is set
            if (argv.predictCost) {
                const prediction = await costPredictor.predictCost(
                    modelChoice.provider.name,
                    modelChoice.model.id,
                    message
                );
                console.log(chalk.cyan("\n" + costPredictor.formatPrediction(prediction) + "\n"));
            }

            // Set up tools
            const tools = this.getAvailableTools();

            console.log(chalk.yellow("> Thinking..."));

            // Send message
            const response = await chatEngine.sendMessage(message, tools);

            // Track usage for single message mode
            if (response.usage) {
                const sessionId = generateSessionId();
                await costTracker.trackUsage(
                    modelChoice.provider.name,
                    modelChoice.model.id,
                    response.usage,
                    sessionId,
                    0
                );
            }

            // Handle output
            const outputConfig = parseOutputFormat(argv.output);
            await outputManager.handleOutput(response.content, outputConfig, {
                provider: modelChoice.provider.name,
                model: modelChoice.model.id,
                cost: response.cost,
                usage: response.usage,
            });

            // Show cost breakdown
            if (response.cost && response.cost > 0) {
                const breakdown = [
                    {
                        provider: modelChoice.provider.name,
                        model: modelChoice.model.id,
                        inputTokens: response.usage?.promptTokens || 0,
                        outputTokens: response.usage?.completionTokens || 0,
                        cachedInputTokens:
                            "cachedPromptTokens" in (response.usage || {}) &&
                            typeof response.usage?.cachedPromptTokens === "number"
                                ? response.usage.cachedPromptTokens
                                : 0,
                        totalTokens: response.usage?.totalTokens || 0,
                        cost: response.cost,
                        currency: "USD",
                    },
                ];

                console.log(await outputManager.formatCostBreakdown(breakdown));
            }
        } catch (error) {
            logger.error(`Chat failed: ${error}`);
            throw error;
        }
    }

    private async startInteractiveChat(argv: Args): Promise<void> {
        console.log(chalk.green("=ï¿½ Starting interactive chat mode"));
        console.log(chalk.gray("Type /help for available commands, /quit to exit\n"));

        try {
            // Select initial model
            const modelChoice = await modelSelector.selectModel();
            if (!modelChoice) {
                logger.error("No model selected. Exiting.");
                process.exit(1);
            }

            console.log(
                chalk.blue(`> Starting with ${colorizeProvider(modelChoice.provider.name)}/${modelChoice.model.name}`)
            );

            // Create chat config
            const chatConfig = await this.createChatConfig(modelChoice, argv);

            // Create chat engine
            const chatEngine = new ChatEngine(chatConfig);

            // Create session
            const sessionId = generateSessionId();
            const session = convManager.createSession(sessionId, modelChoice.provider.name, modelChoice.model.id);

            // Set output format
            if (argv.output) {
                const outputConfig = parseOutputFormat(argv.output);
                if (outputConfig) {
                    outputManager.setOutputFormat(outputConfig);
                }
            }

            let shouldExit = false;

            while (!shouldExit) {
                try {
                    // Get user input
                    const { message } = (await this.prompter.prompt({
                        type: "input",
                        name: "message",
                        message: chalk.cyan("You:"),
                        validate: (input: string) => {
                            if (input.startsWith("/")) {
                                return (
                                    commandHandler.isValidCommand(input) ||
                                    "Unknown command. Type /help for available commands."
                                );
                            }
                            return input.trim().length > 0 || "Please enter a message or command.";
                        },
                    })) as { message: string };

                    // Handle special commands
                    if (message.startsWith("/")) {
                        const result = await commandHandler.handleCommand(
                            message,
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
                    console.log(chalk.yellow("\nAssistant:"));

                    // Set up tools
                    const tools = this.getAvailableTools();

                    const startTime = Date.now();

                    // Send message
                    const response = await chatEngine.sendMessage(message, tools);

                    const duration = Date.now() - startTime;

                    // Show timing info
                    console.log(chalk.gray(`\nï¿½  Response time: ${formatElapsedTime(duration)}`));

                    // Track usage
                    if (response.usage) {
                        const messageIndex = Math.floor(chatEngine.getConversationLength() / 2); // Approximate message index
                        await costTracker.trackUsage(
                            modelChoice.provider.name,
                            modelChoice.model.id,
                            response.usage,
                            sessionId,
                            messageIndex
                        );
                    }

                    // Auto-save conversation every 5 messages
                    if (chatEngine.getConversationLength() % 10 === 0) {
                        // Every 5 pairs (user + assistant)
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
                    if (error instanceof Error && error.message === "canceled") {
                        logger.info("\nOperation cancelled by user.");
                        continue;
                    }
                    logger.error(`Chat error: ${error}`);
                    console.log(chalk.red("=ï¿½ Error occurred. Type /quit to exit or continue chatting."));
                }
            }

            // Save conversation before exiting
            session.messages = chatEngine.exportConversation();
            session.endTime = new Date().toISOString();
            await convManager.saveConversation(session);

            console.log(chalk.green("\n=K Goodbye!"));

            // Show session summary
            console.log(chalk.gray(`Session saved: ${sessionId}`));
            console.log(chalk.gray(`Messages: ${session.messages.length}`));
            console.log(
                chalk.gray(`Duration: ${formatElapsedTime(Date.now() - new Date(session.startTime).getTime())}`)
            );
        } catch (error) {
            if (error instanceof Error && error.message === "canceled") {
                logger.info("\nChat cancelled by user.");
                process.exit(0);
            }
            throw error;
        }
    }

    private async createChatConfig(modelChoice: ProviderChoice, argv: CLIOptions): Promise<ChatConfig> {
        const model = modelChoice.provider.provider(modelChoice.model.id);

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

        // Add more tools here as needed

        return Object.keys(tools).length > 0 ? tools : undefined;
    }

    private async handleCommandResult(
        result: CommandResult,
        chatEngine: ChatEngine,
        modelChoice: ProviderChoice,
        chatConfig: ChatConfig
    ): Promise<void> {
        if (result.newModel && result.newProvider) {
            await chatEngine.switchModel(result.newModel, result.newProvider, result.newModelName);
            // Update modelChoice reference
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
            console.log(chalk.green(" Conversation history cleared"));
        }

        if (result.saveConversation) {
            const session = convManager.createSession(
                generateSessionId(),
                chatConfig.provider,
                chatConfig.modelName,
                chatEngine.exportConversation()
            );
            await convManager.saveConversation(session);
            console.log(chalk.green(` Conversation saved: ${session.id}`));
        }

        if (result.transcriptionFile) {
            try {
                console.log(chalk.blue("<ï¿½ Transcribing audio..."));
                const transcriptionResult = await transcriptionManager.transcribeAudio(result.transcriptionFile);

                // Add transcription as a user message
                await chatEngine.sendMessage(
                    `Transcription of "${result.transcriptionFile}":\n\n${transcriptionResult.text}`
                );

                console.log(
                    chalk.green(` Transcription completed in ${formatElapsedTime(transcriptionResult.processingTime)}`)
                );
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
