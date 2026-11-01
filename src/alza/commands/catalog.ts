import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type Command, InvalidArgumentError } from "commander";
import { SEARCH_SORTS } from "../lib/api";
import { parseIntArg, parseNumberArg, runOperation } from "./run";

interface ListingFlags {
    page?: number;
    limit?: number;
    brand?: number;
    min?: number;
    max?: number;
    inStock?: boolean;
    discounted?: boolean;
}

function addListingFlags(command: Command): Command {
    return command
        .option("--limit <n>", "How many products to return", parseIntArg)
        .option("--brand <id>", `Brand id (see \`${toolCommand("alza filters", "<category>")}\`)`, parseIntArg)
        .option("--min <price>", "Lowest price", parseNumberArg)
        .option("--max <price>", "Highest price", parseNumberArg)
        .option("--in-stock", "Only products you can buy now")
        .option("--discounted", "Only discounted products");
}

function listingInput(flags: ListingFlags) {
    return {
        limit: flags.limit,
        brand_id: flags.brand,
        min_price: flags.min,
        max_price: flags.max,
        in_stock: flags.inStock,
        discounted: flags.discounted,
    };
}

/** `15361:239455089` → { param_id, value_id }. */
function parseFilter(value: string, previous: Array<{ param_id: number; value_id: number }> = []) {
    const match = /^(\d+)[:=](\d+)$/.exec(value.trim());
    if (!match) {
        throw new InvalidArgumentError(`expected <paramId>:<valueId>, got "${value}"`);
    }

    return [...previous, { param_id: Number(match[1]), value_id: Number(match[2]) }];
}

export function registerCatalogCommands(program: Command): void {
    addListingFlags(
        program
            .command("search")
            .description("Search products by keywords")
            .argument("<query...>", "Search words")
            .option("--sort <order>", `Server-side order: ${Object.keys(SEARCH_SORTS).join(", ")}`)
            .option("--page <n>", "First result page, 0-based", parseIntArg)
    ).action(async (query: string[], flags: ListingFlags & { sort?: string }, command: Command) => {
        await runOperation(command, "search_products", {
            query: query.join(" "),
            sort: flags.sort,
            page: flags.page,
            ...listingInput(flags),
        });
    });

    addListingFlags(
        program
            .command("category")
            .description("List the products of a category, with brand and parameter filters")
            .argument("<categoryId>", "Category id", parseIntArg)
            .option("--page <n>", "First page, 1-based", parseIntArg)
            .option(
                "--filter <paramId:valueId>",
                `Parameter filter, repeatable (see \`${toolCommand("alza filters")}\`)`,
                parseFilter
            )
    ).action(async (categoryId: number, flags: ListingFlags & { filter?: unknown[] }, command: Command) => {
        await runOperation(command, "list_category", {
            category_id: categoryId,
            page: flags.page,
            filters: flags.filter,
            ...listingInput(flags),
        });
    });

    program
        .command("product")
        .description("Full detail of a product: price, stock, warranty, EAN and every parameter")
        .argument("<product>", "Code, numeric id or product URL")
        .action(async (product: string, _flags: unknown, command: Command) => {
            await runOperation(command, "get_product", { product });
        });

    program
        .command("reviews")
        .description("Customer reviews with pros, cons, stars and the star distribution")
        .argument("<product>", "Code, numeric id or product URL")
        .option("--limit <n>", "How many reviews (default 50)", parseIntArg)
        .action(async (product: string, flags: { limit?: number }, command: Command) => {
            await runOperation(command, "get_reviews", { product, limit: flags.limit });
        });

    program
        .command("questions")
        .description("Customer questions and their answers")
        .argument("<product>", "Code, numeric id or product URL")
        .option("--limit <n>", "How many questions (default 25)", parseIntArg)
        .option("--no-answers", "Skip the answers")
        .action(async (product: string, flags: { limit?: number; answers: boolean }, command: Command) => {
            await runOperation(command, "get_questions", { product, limit: flags.limit, answers: flags.answers });
        });

    program
        .command("compare")
        .description("Compare 2 to 6 products side by side")
        .argument("<products...>", "Codes, numeric ids or product URLs")
        .action(async (products: string[], _flags: unknown, command: Command) => {
            await runOperation(command, "compare_products", { products });
        });

    program
        .command("alternatives")
        .description("Alternatives to a product (Alza's list, or the best rated in its category)")
        .argument("<product>", "Code, numeric id or product URL")
        .option("--limit <n>", "How many (default 10)", parseIntArg)
        .action(async (product: string, flags: { limit?: number }, command: Command) => {
            await runOperation(command, "recommend_alternatives", { product, limit: flags.limit });
        });

    program
        .command("suggest")
        .description("Search-box suggestions: phrases, products, categories and brands")
        .argument("<query...>", "Partial search text")
        .action(async (query: string[], _flags: unknown, command: Command) => {
            await runOperation(command, "autocomplete", { query: query.join(" ") });
        });

    program
        .command("categories")
        .description("The top-level categories, or a category's path and subcategories")
        .argument("[categoryId]", "Category id; omit for the top level", parseIntArg)
        .action(async (categoryId: number | undefined, _flags: unknown, command: Command) => {
            if (categoryId === undefined) {
                await runOperation(command, "list_categories", {});
                return;
            }

            await runOperation(command, "get_category", { category_id: categoryId });
        });

    program
        .command("filters")
        .description("Brands and parameter filters of a category (ids for --brand and --filter)")
        .argument("<categoryId>", "Category id", parseIntArg)
        .action(async (categoryId: number, _flags: unknown, command: Command) => {
            await runOperation(command, "list_category_filters", { category_id: categoryId });
        });

    program
        .command("deals")
        .description("Discounted products of a search or a category, biggest discount first")
        .argument("[query...]", "Search words (or pass --category)")
        .option("--category <id>", "Category id", parseIntArg)
        .option("--min-discount <percent>", "Smallest discount in percent", parseNumberArg)
        .option("--limit <n>", "How many (default 30)", parseIntArg)
        .option("--pages <n>", "Result pages to scan (default 4)", parseIntArg)
        .action(
            async (
                query: string[],
                flags: { category?: number; minDiscount?: number; limit?: number; pages?: number },
                command: Command
            ) => {
                await runOperation(command, "get_deals", {
                    query: query.length ? query.join(" ") : undefined,
                    category_id: flags.category,
                    min_discount: flags.minDiscount,
                    limit: flags.limit,
                    pages: flags.pages,
                });
            }
        );

    program
        .command("ean")
        .description("Find products by EAN barcode")
        .argument("<eans...>", "EAN codes")
        .action(async (eans: string[], _flags: unknown, command: Command) => {
            await runOperation(command, "find_by_ean", { eans });
        });

    program
        .command("history")
        .description("Price history from Hlídač shopů: lowest, highest, 30-day low, real discount")
        .argument("<product>", "Code, numeric id or product URL")
        .action(async (product: string, _flags: unknown, command: Command) => {
            await runOperation(command, "price_history", { product });
        });

    program
        .command("pickup")
        .description("AlzaBox lockers nearest to a postal code, a place or 'lat,lon'")
        .argument("<near...>", "Postal code, place name or 'lat,lon'")
        .option("--limit <n>", "How many (default 10)", parseIntArg)
        .action(async (near: string[], flags: { limit?: number }, command: Command) => {
            await runOperation(command, "find_pickup_points", { near: near.join(" "), limit: flags.limit });
        });
}
