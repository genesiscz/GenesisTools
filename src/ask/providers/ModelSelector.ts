import { providerManager } from "@ask/providers/ProviderManager";
import type { DetectedProvider, ModelInfo, ProviderChoice } from "@ask/types";
import { colorizeByPriceTier } from "@ask/utils/helpers";
import * as p from "@clack/prompts";
import { logger } from "@genesiscz/utils/logger";
import type { SearchItem } from "@genesiscz/utils/prompts/clack";
import { searchSelect, searchSelectCancelSymbol } from "@genesiscz/utils/prompts/clack";
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

    /**
     * Fuzzy-match a model query across all (or one) provider's models.
     * Returns exact match first, then substring matches.
     * If exactly one match is found, returns it. If multiple, returns all for disambiguation.
     */
    async fuzzyMatchModel(
        query: string,
        providerName?: string
    ): Promise<{ matches: Array<{ provider: DetectedProvider; model: ModelInfo }>; exact: boolean }> {
        const providers = await providerManager.detectProviders();
        const candidates = providerName ? providers.filter((p) => p.name === providerName) : providers;

        const queryLower = query.toLowerCase();
        const matches: Array<{ provider: DetectedProvider; model: ModelInfo }> = [];
        const exact = false;

        for (const provider of candidates) {
            for (const model of provider.models) {
                const idLower = model.id.toLowerCase();
                const nameLower = (model.name || model.id).toLowerCase();

                if (idLower === queryLower || nameLower === queryLower) {
                    return { matches: [{ provider, model }], exact: true };
                }

                if (idLower.includes(queryLower) || nameLower.includes(queryLower)) {
                    matches.push({ provider, model });
                }
            }
        }

        return { matches, exact };
    }

    async selectModelByName(providerName?: string, modelName?: string): Promise<ProviderChoice | null> {
        try {
            const providers = await providerManager.detectProviders(providerName);

            let targetProvider: DetectedProvider | undefined;
            let targetModel: ModelInfo | undefined;

            if (modelName && !providerName) {
                for (const provider of providers) {
                    const model = provider.models.find((m) => m.id === modelName || m.name === modelName);
                    if (model) {
                        targetProvider = provider;
                        targetModel = model;
                        logger.info(
                            `Auto-selected provider ${pc.cyan(provider.name)} for model ${pc.yellow(modelName)}`
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
                                .join(", ")}`
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
}

// Singleton instance
export const modelSelector = new ModelSelector();
