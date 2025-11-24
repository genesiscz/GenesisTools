import Enquirer from "enquirer";
import chalk from "chalk";
import type { ProviderV1 } from "@ai-sdk/provider";
import logger from "../../logger";
import type { DetectedProvider, ModelInfo, ProviderChoice } from "../types";
import { providerManager } from "./ProviderManager";

export class ModelSelector {
    private prompter = new Enquirer();

    async selectModel(): Promise<ProviderChoice | null> {
        try {
            const providers = await providerManager.detectProviders();

            if (providers.length === 0) {
                logger.error("No AI providers available. Please configure API keys.");
                return null;
            }

            if (providers.length === 1) {
                // Only one provider, select a model from it
                const model = await this.selectModelFromProvider(providers[0]);
                return model ? { provider: providers[0], model } : null;
            }

            // Multiple providers, let user choose first
            const providerChoice = await this.selectProvider(providers);
            if (!providerChoice) {
                return null;
            }

            const model = await this.selectModelFromProvider(providerChoice);
            return model ? { provider: providerChoice, model } : null;
        } catch (error) {
            if (error instanceof Error && error.message === "canceled") {
                logger.info("\nModel selection cancelled.");
                return null;
            }
            throw error;
        }
    }

    async selectProvider(providers: DetectedProvider[]): Promise<DetectedProvider | null> {
        const choices = providers.map((provider) => ({
            name: provider.name,
            message: `${chalk.cyan(provider.name)} - ${
                provider.config.description || `${provider.models.length} models available`
            }`,
            value: provider,
        }));

        try {
            const response = (await this.prompter.prompt({
                type: "select",
                name: "provider",
                message: "Choose AI provider:",
                choices: choices,
            })) as { provider: string };

            const selectedProvider = providers.find((p) => p.name === response.provider);
            return selectedProvider || null;
        } catch (error) {
            if (error instanceof Error && error.message === "canceled") {
                return null;
            }
            throw error;
        }
    }

    async selectModelFromProvider(provider: DetectedProvider): Promise<ModelInfo | null> {
        if (provider.models.length === 0) {
            logger.error(`No models available for ${provider.name}`);
            return null;
        }

        if (provider.models.length === 1) {
            logger.info(`Using only available model: ${provider.models[0].name}`);
            return provider.models[0];
        }

        const choices = provider.models.map((model) => ({
            name: model.id,
            message: this.formatModelChoice(model),
            value: model,
        }));

        try {
            const response = (await this.prompter.prompt({
                type: "autocomplete",
                name: "model",
                message: `Choose ${chalk.cyan(provider.name)} model:`,
                choices: choices,
                suggest(input: string, choices: Array<{ name: string; message: string; value: unknown }>) {
                    if (!input) return choices;

                    return choices.filter((choice) => {
                        const value = choice.value as { name: string; id: string };
                        const searchText = `${value.name} ${value.id}`.toLowerCase();
                        return searchText.includes(input.toLowerCase());
                    });
                },
            })) as { model: string | ModelInfo };

            // Fix: Handle both string and object response from enquirer
            let modelName: string;
            let selectedModel: ModelInfo | null = null;

            if (typeof response.model === "string") {
                modelName = response.model;
                const choice = choices.find((c) => c.name === modelName);
                selectedModel = choice ? (choice.value as ModelInfo) : null;
            } else {
                selectedModel = response.model as ModelInfo;
            }

            return selectedModel;
        } catch (error) {
            if (error instanceof Error && error.message === "canceled") {
                return null;
            }
            throw error;
        }
    }

    private formatModelChoice(model: ModelInfo): string {
        const parts = [chalk.green(model.name), chalk.gray(`(${this.formatTokens(model.contextWindow)} tokens)`)];

        if (model.pricing) {
            const costStr =
                model.pricing.inputPer1M != null && model.pricing.outputPer1M != null
                    ? chalk.yellow(
                          `$${model.pricing.inputPer1M.toFixed(2)}/${model.pricing.outputPer1M.toFixed(
                              2
                          )} per 1M tokens`
                      )
                    : chalk.yellow("pricing unknown");
            parts.push(costStr);
        }

        if (model.capabilities.length > 0) {
            const caps = model.capabilities
                .map((cap) => {
                    switch (cap) {
                        case "vision":
                            return chalk.blue("👁️");
                        case "function-calling":
                            return chalk.magenta("🔧");
                        case "reasoning":
                            return chalk.red("🧠");
                        default:
                            return chalk.gray(cap);
                    }
                })
                .join(" ");
            parts.push(caps);
        }

        return parts.join(" ");
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(1)}M`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toString();
    }

    async selectModelByName(providerName?: string, modelName?: string): Promise<ProviderChoice | null> {
        try {
            const providers = await providerManager.detectProviders();

            let targetProvider: DetectedProvider | undefined;
            let targetModel: ModelInfo | undefined;

            // If model is specified but provider is not, try to find the provider that has this model
            if (modelName && !providerName) {
                for (const provider of providers) {
                    const model = provider.models.find((m) => m.id === modelName || m.name === modelName);
                    if (model) {
                        targetProvider = provider;
                        targetModel = model;
                        logger.info(
                            `Auto-selected provider ${chalk.cyan(provider.name)} for model ${chalk.yellow(modelName)}`
                        );
                        break;
                    }
                }

                if (!targetProvider) {
                    logger.error(`Model "${modelName}" not found in any provider.`);
                    logger.info(`Available models by provider:`);
                    for (const provider of providers) {
                        const modelIds = provider.models.map((m) => m.id).join(", ");
                        logger.info(`  ${provider.name}: ${modelIds}`);
                    }
                    return null;
                }
            } else {
                // Normal provider-first selection
                if (providerName) {
                    targetProvider = providers.find((p) => p.name === providerName);
                    if (!targetProvider) {
                        logger.error(
                            `Provider "${providerName}" not found. Available: ${providers
                                .map((p) => p.name)
                                .join(", ")}`
                        );
                        return null;
                    }
                } else if (providers.length === 1) {
                    targetProvider = providers[0];
                } else {
                    logger.error("Multiple providers available. Please specify a provider.");
                    logger.info(`Available providers: ${providers.map((p) => p.name).join(", ")}`);
                    return null;
                }

                if (modelName) {
                    targetModel = targetProvider.models.find((m) => m.id === modelName || m.name === modelName);
                    if (!targetModel) {
                        logger.error(`Model "${modelName}" not found for provider "${providerName}".`);
                        logger.info(`Available models: ${targetProvider.models.map((m) => m.id).join(", ")}`);
                        return null;
                    }
                } else if (targetProvider.models.length === 1) {
                    targetModel = targetProvider.models[0];
                } else {
                    logger.error("Multiple models available. Please specify a model.");
                    logger.info(`Available models: ${targetProvider.models.map((m) => m.id).join(", ")}`);
                    return null;
                }
            }

            if (!targetProvider || !targetModel) {
                return null;
            }
            return { provider: targetProvider, model: targetModel };
        } catch (error) {
            logger.error(`Failed to select model: ${error}`);
            return null;
        }
    }

    async selectTranscriptionModel(
        fileSize?: number
    ): Promise<{ provider: string; model: string; providerInstance: ProviderV1 } | null> {
        const transcriptionProviders = [
            { name: "groq", envKey: "GROQ_API_KEY", model: "whisper-large-v3", maxFileSize: 25 * 1024 * 1024 },
            {
                name: "openrouter",
                envKey: "OPENROUTER_API_KEY",
                model: "openai/whisper-1",
                maxFileSize: 25 * 1024 * 1024,
            },
            { name: "openai", envKey: "OPENAI_API_KEY", model: "whisper-1", maxFileSize: 25 * 1024 * 1024 },
            { name: "assemblyai", envKey: "ASSEMBLYAI_API_KEY", model: "best", maxFileSize: 100 * 1024 * 1024 },
            { name: "deepgram", envKey: "DEEPGRAM_API_KEY", model: "nova-3", maxFileSize: 100 * 1024 * 1024 },
            { name: "gladia", envKey: "GLADIA_API_KEY", model: "default", maxFileSize: 100 * 1024 * 1024 },
        ];

        // Filter by file size and available API keys
        const availableProviders = transcriptionProviders.filter((p) => {
            if (fileSize && fileSize > p.maxFileSize) {
                return false;
            }
            return process.env[p.envKey];
        });

        if (availableProviders.length === 0) {
            logger.error("No transcription providers available. Please set API keys for audio transcription.");
            logger.info(
                "Supported: GROQ_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ASSEMBLYAI_API_KEY, DEEPGRAM_API_KEY, GLADIA_API_KEY"
            );
            return null;
        }

        // Select best provider based on priority
        const selectedProvider = availableProviders[0];

        try {
            let providerInstance: ProviderV1;

            switch (selectedProvider.name) {
                case "groq": {
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { groq } = await import("@ai-sdk/groq");
                    providerInstance = groq;
                    break;
                }
                case "openrouter": {
                    const { createOpenAI } = await import("@ai-sdk/openai");
                    providerInstance = createOpenAI({
                        apiKey: process.env.OPENROUTER_API_KEY,
                        baseURL: "https://openrouter.ai/api/v1",
                    });
                    break;
                }
                case "openai": {
                    const { openai } = await import("@ai-sdk/openai");
                    providerInstance = openai;
                    break;
                }
                case "assemblyai": {
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { assemblyai } = await import("@ai-sdk/assemblyai");
                    providerInstance = assemblyai;
                    break;
                }
                case "deepgram": {
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { deepgram } = await import("@ai-sdk/deepgram");
                    providerInstance = deepgram;
                    break;
                }
                case "gladia": {
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { gladia } = await import("@ai-sdk/gladia");
                    providerInstance = gladia;
                    break;
                }
                default:
                    throw new Error(`Unsupported transcription provider: ${selectedProvider.name}`);
            }

            logger.info(`Using ${selectedProvider.name} for transcription (${selectedProvider.model})`);

            return {
                provider: selectedProvider.name,
                model: selectedProvider.model,
                providerInstance,
            };
        } catch (error) {
            logger.error(`Failed to create transcription provider ${selectedProvider.name}: ${error}`);
            return null;
        }
    }
}

// Singleton instance
export const modelSelector = new ModelSelector();
