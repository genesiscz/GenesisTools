import chalk from "chalk";
import Table from "cli-table3";
import logger from "../../logger";
import { providerManager } from "../providers/ProviderManager";
import { dynamicPricingManager } from "../providers/DynamicPricing";
import type { PricingInfo } from "../types/provider";

export interface PricingOptions {
    provider?: string;
    format?: "table" | "json";
}

function formatContextWindow(tokens: number): string {
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1)}M`;
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(0)}k`;
    }
    return tokens.toString();
}

async function showPricingTable(providerFilter?: string) {
    console.log(chalk.bold.cyan("\n💰 MODEL PRICING\n"));

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
        console.log(chalk.bold.blue(`\n${provider.name.toUpperCase()} (${provider.models.length} models)\n`));

        // Fetch pricing for all models
        const modelsWithPricing = await Promise.all(
            provider.models.map(async (model) => {
                const pricing = await dynamicPricingManager.getPricing(provider.name, model.id);
                return { model, pricing };
            })
        );

        // Sort by input cost (cheapest first)
        modelsWithPricing.sort((a, b) => {
            const aCost = a.pricing?.inputPer1M ?? Infinity;
            const bCost = b.pricing?.inputPer1M ?? Infinity;
            return aCost - bCost;
        });

        const table = new Table({
            head: ["Model", "Context", "Input/1M", "Output/1M", "Capabilities"],
            style: { head: ["cyan"] },
            colWidths: [35, 10, 15, 15, 25],
        });

        for (const { model, pricing } of modelsWithPricing) {
            const inputPrice = pricing?.inputPer1M
                ? chalk.yellow(`$${pricing.inputPer1M.toFixed(2)}`)
                : chalk.gray("N/A");
            const outputPrice = pricing?.outputPer1M
                ? chalk.cyan(`$${pricing.outputPer1M.toFixed(2)}`)
                : chalk.gray("N/A");

            const capabilities = model.capabilities.join(", ");

            table.push([
                chalk.green(model.name || model.id),
                formatContextWindow(model.contextWindow),
                inputPrice,
                outputPrice,
                capabilities,
            ]);
        }

        console.log(table.toString());
    }

    // Show summary
    console.log(chalk.bold.cyan("\n📊 PRICING SUMMARY\n"));
    const allModels = filteredProviders.flatMap((p) => p.models);
    const modelsWithPricing = await Promise.all(
        allModels.map(async (model) => {
            const provider = filteredProviders.find((p) => p.models.includes(model));
            if (!provider) return null;
            const pricing = await dynamicPricingManager.getPricing(provider.name, model.id);
            return { provider: provider.name, model, pricing };
        })
    );

    const validModels = modelsWithPricing.filter((m): m is NonNullable<typeof m> => m !== null && m.pricing !== null);

    if (validModels.length > 0) {
        // Find cheapest and most expensive
        const cheapest = validModels.reduce((min, m) =>
            (m.pricing?.inputPer1M ?? Infinity) < (min.pricing?.inputPer1M ?? Infinity) ? m : min
        );
        const mostExpensive = validModels.reduce((max, m) =>
            (m.pricing?.inputPer1M ?? 0) > (max.pricing?.inputPer1M ?? 0) ? m : max
        );

        console.log(chalk.white(`Total Models: ${validModels.length}`));
        console.log(
            chalk.white(
                `Cheapest Input: ${chalk.green(cheapest.model.name || cheapest.model.id)} (${chalk.yellow(
                    `$${cheapest.pricing?.inputPer1M.toFixed(2)}/1M`
                )})`
            )
        );
        console.log(
            chalk.white(
                `Most Expensive Input: ${chalk.red(mostExpensive.model.name || mostExpensive.model.id)} (${chalk.yellow(
                    `$${mostExpensive.pricing?.inputPer1M.toFixed(2)}/1M`
                )})`
            )
        );

        // Count tiered pricing models
        const tieredModels = validModels.filter(
            (m) => m.pricing?.inputPer1MAbove200k || m.pricing?.outputPer1MAbove200k
        );
        if (tieredModels.length > 0) {
            console.log(chalk.white(`Tiered Pricing Models: ${chalk.magenta(tieredModels.length.toString())}`));
        }
    }
}

async function showPricingJSON(providerFilter?: string) {
    const providers = await providerManager.detectProviders();
    const filteredProviders = providerFilter
        ? providers.filter((p) => p.name.toLowerCase() === providerFilter.toLowerCase())
        : providers;

    const output: Record<string, any> = {};

    for (const provider of filteredProviders) {
        const models: any[] = [];

        for (const model of provider.models) {
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

export async function showPricing(options: PricingOptions = {}): Promise<void> {
    const format = options.format || "table";
    const provider = options.provider;

    try {
        if (format === "json") {
            await showPricingJSON(provider);
        } else {
            await showPricingTable(provider);
        }
    } catch (error) {
        logger.error(`Pricing display failed: ${error}`);
        throw error;
    }
}
