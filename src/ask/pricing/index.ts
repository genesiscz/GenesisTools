import chalk from "chalk";
import Table from "cli-table3";
import logger from "@app/logger";
import { providerManager } from "@ask/providers/ProviderManager";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import type { ModelsOptions } from "@ask/types/cli";

// Re-export for backward compatibility
export type { ModelsOptions as PricingOptions } from "@ask/types/cli";

function formatContextWindow(tokens: number): string {
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1)}M`;
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(0)}k`;
    }
    return tokens.toString();
}

function formatPrice(price: number | undefined): string {
    if (price === undefined) return chalk.gray("N/A");
    if (price === 0) return chalk.green("Free");
    return `$${price.toFixed(4)}`;
}

function formatCapabilities(capabilities: string[]): string {
    return capabilities
        .map((cap) => {
            switch (cap.toLowerCase()) {
                case "chat":
                    return chalk.blue("chat");
                case "vision":
                    return chalk.magenta("vision");
                case "function-calling":
                    return chalk.yellow("functions");
                case "reasoning":
                    return chalk.cyan("reasoning");
                default:
                    return cap;
            }
        })
        .join(", ");
}

function normalizeCapability(cap: string): string {
    const normalized = cap.toLowerCase().trim();
    // Map common variations
    if (normalized === "functions" || normalized === "function-calling") {
        return "function-calling";
    }
    return normalized;
}

function matchesCapabilities(modelCapabilities: string[], filterCapabilities: string[]): boolean {
    const normalizedModelCaps = modelCapabilities.map(normalizeCapability);
    const normalizedFilterCaps = filterCapabilities.map(normalizeCapability);

    // Check if model has ALL of the requested capabilities
    return normalizedFilterCaps.every((filterCap) => normalizedModelCaps.includes(filterCap));
}

function sortModels(modelsWithPricing: Array<{ model: any; pricing: any }>, sortBy?: ModelsOptions["sort"]): void {
    if (!sortBy || sortBy === "price_input" || sortBy === "input") {
        // Sort by input cost (cheapest first)
        modelsWithPricing.sort((a, b) => {
            const aCost = a.pricing?.inputPer1M ?? Infinity;
            const bCost = b.pricing?.inputPer1M ?? Infinity;
            return aCost - bCost;
        });
    } else if (sortBy === "price_output" || sortBy === "output") {
        // Sort by output cost (cheapest first)
        modelsWithPricing.sort((a, b) => {
            const aCost = a.pricing?.outputPer1M ?? Infinity;
            const bCost = b.pricing?.outputPer1M ?? Infinity;
            return aCost - bCost;
        });
    } else if (sortBy === "name") {
        // Sort by name alphabetically
        modelsWithPricing.sort((a, b) => {
            const aName = a.model.name || a.model.id;
            const bName = b.model.name || b.model.id;
            return aName.localeCompare(bName);
        });
    }
}

async function showPricingTable(providerFilter?: string, sortBy?: ModelsOptions["sort"], filterCapabilities?: string) {
    console.log(chalk.bold.cyan("\n💰 MODEL PRICING & INFORMATION\n"));

    const providers = await providerManager.detectProviders();
    const filteredProviders = providerFilter
        ? providers.filter((p) => p.name.toLowerCase() === providerFilter.toLowerCase())
        : providers;

    if (filteredProviders.length === 0) {
        console.log(chalk.yellow(`No providers found${providerFilter ? ` matching "${providerFilter}"` : ""}`));
        return;
    }

    // Group models by provider
    for (const provider of filteredProviders) {
        console.log(
            chalk.bold.blue(
                `\n${provider.name.toUpperCase()} (${provider.models.length} model${
                    provider.models.length !== 1 ? "s" : ""
                })`
            )
        );
        if (provider.config.description) {
            console.log(chalk.gray(`  ${provider.config.description}\n`));
        } else {
            console.log();
        }

        // Fetch pricing for all models
        let modelsWithPricing = await Promise.all(
            provider.models.map(async (model) => {
                const pricing = await dynamicPricingManager.getPricing(provider.name, model.id);
                return { model, pricing };
            })
        );

        // Filter by capabilities if specified
        if (filterCapabilities) {
            const filterCaps = filterCapabilities
                .split("|")
                .map((cap) => cap.trim())
                .filter(Boolean);
            modelsWithPricing = modelsWithPricing.filter(({ model }) =>
                matchesCapabilities(model.capabilities, filterCaps)
            );
        }

        // Sort models
        sortModels(modelsWithPricing, sortBy);

        const table = new Table({
            head: ["Model Name", "ID", "Context", "Input/1M", "Output/1M", "Cached/1M", "Capabilities"],
            style: { head: ["cyan"] },
            colWidths: [30, 30, 10, 12, 12, 12, 30],
        });

        for (const { model, pricing } of modelsWithPricing) {
            const modelName = model.name || model.id;
            const modelId = chalk.gray(model.id);
            const context = formatContextWindow(model.contextWindow);
            const inputPrice = formatPrice(pricing?.inputPer1M);
            const outputPrice = formatPrice(pricing?.outputPer1M);
            const cachedPrice = formatPrice(pricing?.cachedReadPer1M);
            const capabilities = formatCapabilities(model.capabilities);

            table.push([chalk.green(modelName), modelId, context, inputPrice, outputPrice, cachedPrice, capabilities]);
        }

        console.log(table.toString());
    }

    // Show summary
    console.log(chalk.bold.cyan("\n📊 SUMMARY\n"));

    // Collect all filtered models (accounting for capability filtering)
    const allFilteredModels: Array<{ model: any; provider: string; pricing: any }> = [];
    for (const provider of filteredProviders) {
        const modelsWithPricing = await Promise.all(
            provider.models.map(async (model) => {
                // Apply capability filter if specified
                if (filterCapabilities) {
                    const filterCaps = filterCapabilities
                        .split("|")
                        .map((cap) => cap.trim())
                        .filter(Boolean);
                    if (!matchesCapabilities(model.capabilities, filterCaps)) {
                        return null;
                    }
                }
                const pricing = await dynamicPricingManager.getPricing(provider.name, model.id);
                return { model, provider: provider.name, pricing };
            })
        );
        allFilteredModels.push(...modelsWithPricing.filter((m): m is NonNullable<typeof m> => m !== null));
    }

    const totalProviders = filteredProviders.length;
    const totalModels = allFilteredModels.length;

    console.log(chalk.white(`Total Providers: ${chalk.cyan(totalProviders.toString())}`));
    console.log(chalk.white(`Total Models: ${chalk.cyan(totalModels.toString())}`));

    const modelsWithPricing = allFilteredModels;

    const validModels = modelsWithPricing.filter((m) => m.pricing !== null);

    if (validModels.length > 0) {
        // Find cheapest and most expensive
        const cheapest = validModels.reduce((min, m) =>
            (m.pricing?.inputPer1M ?? Infinity) < (min.pricing?.inputPer1M ?? Infinity) ? m : min
        );
        const mostExpensive = validModels.reduce((max, m) =>
            (m.pricing?.inputPer1M ?? 0) > (max.pricing?.inputPer1M ?? 0) ? m : max
        );

        console.log(chalk.white("\nPricing:"));
        console.log(
            chalk.white(
                `  Cheapest Input: ${chalk.green(cheapest.model.name || cheapest.model.id)} (${chalk.yellow(
                    `$${cheapest.pricing?.inputPer1M.toFixed(4)}/1M`
                )})`
            )
        );
        console.log(
            chalk.white(
                `  Most Expensive Input: ${chalk.red(
                    mostExpensive.model.name || mostExpensive.model.id
                )} (${chalk.yellow(`$${mostExpensive.pricing?.inputPer1M.toFixed(4)}/1M`)})`
            )
        );

        // Count tiered pricing models
        const tieredModels = validModels.filter(
            (m) => m.pricing?.inputPer1MAbove200k || m.pricing?.outputPer1MAbove200k
        );
        if (tieredModels.length > 0) {
            console.log(chalk.white(`  Tiered Pricing Models: ${chalk.magenta(tieredModels.length.toString())}`));
        }
    }

    // Count capabilities
    const capabilityCounts: Record<string, number> = {};
    modelsWithPricing.forEach(({ model }) => {
        model.capabilities.forEach((cap) => {
            capabilityCounts[cap] = (capabilityCounts[cap] || 0) + 1;
        });
    });

    if (Object.keys(capabilityCounts).length > 0) {
        console.log(chalk.white("\nCapabilities:"));
        Object.entries(capabilityCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([cap, count]) => {
                console.log(chalk.white(`  ${cap}: ${chalk.cyan(count.toString())}`));
            });
    }

    // Context window stats
    const contextWindows = modelsWithPricing.map(({ model }) => model.contextWindow).sort((a, b) => b - a);
    if (contextWindows.length > 0) {
        const maxContext = contextWindows[0];
        const minContext = contextWindows[contextWindows.length - 1];
        const avgContext = Math.round(contextWindows.reduce((a, b) => a + b, 0) / contextWindows.length);

        console.log(chalk.white("\nContext Windows:"));
        console.log(chalk.white(`  Max: ${chalk.cyan(formatContextWindow(maxContext))}`));
        console.log(chalk.white(`  Min: ${chalk.cyan(formatContextWindow(minContext))}`));
        console.log(chalk.white(`  Avg: ${chalk.cyan(formatContextWindow(avgContext))}`));
    }
}

async function showPricingJSON(providerFilter?: string, filterCapabilities?: string) {
    const providers = await providerManager.detectProviders();
    const filteredProviders = providerFilter
        ? providers.filter((p) => p.name.toLowerCase() === providerFilter.toLowerCase())
        : providers;

    const output: Record<string, any> = {};

    for (const provider of filteredProviders) {
        const models: any[] = [];

        for (const model of provider.models) {
            // Filter by capabilities if specified
            if (filterCapabilities) {
                const filterCaps = filterCapabilities
                    .split("|")
                    .map((cap) => cap.trim())
                    .filter(Boolean);
                if (!matchesCapabilities(model.capabilities, filterCaps)) {
                    continue;
                }
            }

            const pricing = await dynamicPricingManager.getPricing(provider.name, model.id);
            models.push({
                id: model.id,
                name: model.name,
                contextWindow: model.contextWindow,
                capabilities: model.capabilities,
                pricing: pricing
                    ? {
                          inputPer1M: pricing.inputPer1M,
                          outputPer1M: pricing.outputPer1M,
                          cachedReadPer1M: pricing.cachedReadPer1M,
                          cachedCreatePer1M: pricing.cachedCreatePer1M,
                          inputPer1MAbove200k: pricing.inputPer1MAbove200k,
                          outputPer1MAbove200k: pricing.outputPer1MAbove200k,
                          cachedReadPer1MAbove200k: pricing.cachedReadPer1MAbove200k,
                          cachedCreatePer1MAbove200k: pricing.cachedCreatePer1MAbove200k,
                      }
                    : null,
            });
        }

        output[provider.name] = {
            name: provider.name,
            type: provider.type,
            description: provider.config.description,
            models,
        };
    }

    console.log(JSON.stringify(output, null, 2));
}

export async function showPricing(options: ModelsOptions = {}): Promise<void> {
    const format = options.format || "table";
    const provider = options.provider;
    const sortBy = options.sort;
    const filterCapabilities = options.filterCapabilities;

    try {
        if (format === "json") {
            await showPricingJSON(provider, filterCapabilities);
        } else {
            await showPricingTable(provider, sortBy, filterCapabilities);
        }
    } catch (error) {
        logger.error(`Pricing display failed: ${error}`);
        throw error;
    }
}
