import type { ProviderV2 } from "@ai-sdk/provider";
import logger from "@app/logger";
import type { SearchItem } from "@app/utils/prompts/clack";
import { searchSelect, searchSelectCancelSymbol } from "@app/utils/prompts/clack";
import { providerManager } from "@ask/providers/ProviderManager";
import type { DetectedProvider, ModelInfo, ProviderChoice } from "@ask/types";
import { colorizeByPriceTier } from "@ask/utils/helpers";
import * as p from "@clack/prompts";
import pc from "picocolors";

export class ModelSelector {
    async selectModel(): Promise<ProviderChoice | null> {
        const providers = await providerManager.detectProviders();

        if (providers.length === 0) {
            logger.error("No AI providers available. Please configure API keys.");
            return null;
        }

        if (providers.length === 1) {
            const model = await this.selectModelFromProvider(providers[0]);
            return model ? { provider: providers[0], model } : null;
        }

        const providerChoice = await this.selectProvider(providers);
        if (!providerChoice) {
            return null;
        }

        const model = await this.selectModelFromProvider(providerChoice);
        return model ? { provider: providerChoice, model } : null;
    }

    async selectProvider(providers: DetectedProvider[]): Promise<DetectedProvider | null> {
        const result = await p.select({
            message: "Choose AI provider:",
            options: providers.map((provider) => ({
                value: provider,
                label: pc.cyan(provider.name),
                hint: provider.config.description || `${provider.models.length} models`,
            })),
        });

        if (p.isCancel(result)) {
            return null;
        }
        return result;
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

        const sortedModels = [...provider.models].sort((a, b) => {
            const aName = a.name || a.id;
            const bName = b.name || b.id;
            return aName.localeCompare(bName);
        });

        const items: SearchItem<ModelInfo>[] = sortedModels.map((model) => ({
            label: this.formatModelChoice(model),
            value: model,
            hint: model.id,
        }));

        const result = await searchSelect({
            message: `Choose ${pc.cyan(provider.name)} model:`,
            items,
        });

        if (result === searchSelectCancelSymbol) {
            return null;
        }
        return result as ModelInfo;
    }

    private formatModelChoice(model: ModelInfo): string {
        const name = colorizeByPriceTier(model.name, model.pricing?.inputPer1M);
        const parts = [name, pc.dim(`(${this.formatTokens(model.contextWindow)} ctx)`)];

        if (model.pricing) {
            const costStr =
                model.pricing.inputPer1M != null && model.pricing.outputPer1M != null
                    ? pc.dim(`$${model.pricing.inputPer1M.toFixed(2)}/$${model.pricing.outputPer1M.toFixed(2)} /1M`)
                    : pc.dim("pricing unknown");
            parts.push(costStr);
        }

        if (model.capabilities.length > 0) {
            const caps = model.capabilities
                .map((cap) => {
                    switch (cap) {
                        case "vision":
                            return pc.blue("V");
                        case "function-calling":
                            return pc.magenta("F");
                        case "reasoning":
                            return pc.red("R");
                        default:
                            return pc.dim(cap);
                    }
                })
                .join("");
            if (caps) {
                parts.push(pc.dim("[") + caps + pc.dim("]"));
            }
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

            if (modelName && !providerName) {
                for (const provider of providers) {
                    const model = provider.models.find((m) => m.id === modelName || m.name === modelName);
                    if (model) {
                        targetProvider = provider;
                        targetModel = model;
                        logger.info(
                            `Auto-selected provider ${pc.cyan(provider.name)} for model ${pc.yellow(modelName)}`,
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
                if (providerName) {
                    targetProvider = providers.find((prov) => prov.name === providerName);
                    if (!targetProvider) {
                        logger.error(
                            `Provider "${providerName}" not found. Available: ${providers
                                .map((prov) => prov.name)
                                .join(", ")}`,
                        );
                        return null;
                    }
                } else if (providers.length === 1) {
                    targetProvider = providers[0];
                } else {
                    logger.error("Multiple providers available. Please specify a provider.");
                    logger.info(`Available providers: ${providers.map((prov) => prov.name).join(", ")}`);
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
        fileSize?: number,
    ): Promise<{ provider: string; model: string; providerInstance: ProviderV2 } | null> {
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

        const availableProviders = transcriptionProviders.filter((prov) => {
            if (fileSize && fileSize > prov.maxFileSize) {
                return false;
            }
            return process.env[prov.envKey];
        });

        if (availableProviders.length === 0) {
            logger.error("No transcription providers available. Please set API keys for audio transcription.");
            logger.info(
                "Supported: GROQ_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ASSEMBLYAI_API_KEY, DEEPGRAM_API_KEY, GLADIA_API_KEY",
            );
            return null;
        }

        const selectedProvider = availableProviders[0];

        try {
            let providerInstance: ProviderV2;

            switch (selectedProvider.name) {
                case "groq": {
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
