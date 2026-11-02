import { z } from "zod";
import type { AlzaApi } from "./api";
import { SEARCH_SORTS, type SearchSort } from "./api";
import {
    autocomplete,
    compareProducts,
    getAlternatives,
    getCategory,
    getCategoryFilters,
    getDeals,
    getProduct,
    getQuestions,
    getReviews,
    listCategory,
    productsByEan,
    searchProducts,
} from "./catalog";
import { categoriesMarkdown, listCategories } from "./categories";
import {
    categoryMarkdown,
    compareMarkdown,
    filtersMarkdown,
    historyMarkdown,
    listingMarkdown,
    pickupMarkdown,
    productMarkdown,
    questionsMarkdown,
    reviewsMarkdown,
    suggestionsMarkdown,
} from "./format";
import { getPriceHistory } from "./history";
import { PC_ROLES } from "./pc-build";
import { alzaPcCatalog } from "./pc-build-catalog";
import { buildReportMarkdown } from "./pc-build-format";
import { DEFAULT_MAX_DETAIL_FETCHES, MAX_CHECK_PARTS, MAX_DETAIL_FETCHES, PcBuilder } from "./pc-build-service";
import { findPickupPoints } from "./pickup";

/**
 * Every Alza feature, once. The MCP server lists this table as its tools and the CLI commands call the same
 * entries, so a behaviour cannot exist behind one door only.
 */

export interface OperationResult {
    data: unknown;
    markdown: string;
}

export interface AlzaOperation {
    name: string;
    description: string;
    input: z.ZodObject;
    run(api: AlzaApi, args: unknown): Promise<OperationResult>;
}

function operation<S extends z.ZodObject>(def: {
    name: string;
    description: string;
    input: S;
    run(api: AlzaApi, input: z.infer<S>): Promise<OperationResult>;
}): AlzaOperation {
    return { ...def, run: (api, args) => def.run(api, def.input.parse(args)) };
}

const product = z
    .string()
    .min(1)
    .describe("Product code (AUPR65708), numeric id (9383715) or product URL (…-d9383715.htm)");
const limit = (fallback: number, max: number) =>
    z.number().int().min(1).max(max).optional().describe(`How many to return (default ${fallback}, max ${max})`);
const sortKeys = Object.keys(SEARCH_SORTS) as [SearchSort, ...SearchSort[]];

const skip = z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
        "Matching products of the first page to leave out: next.skip of the previous answer, with page = next.page"
    );

const listingFilters = {
    min_price: z.number().min(0).optional().describe("Lowest price, in the storefront currency"),
    max_price: z.number().min(0).optional().describe("Highest price, in the storefront currency"),
    in_stock: z.boolean().optional().describe("Only products you can buy now"),
    discounted: z.boolean().optional().describe("Only discounted products"),
};

export const SEARCH_INPUT = z.object({
    query: z.string().min(1).describe("Search words, e.g. 'alkohol tester'"),
    sort: z
        .enum(sortKeys)
        .optional()
        .describe("relevance (default), price-asc, price-desc, newest, rating (server-side)"),
    page: z.number().int().min(0).optional().describe("First result page, 0-based"),
    skip,
    limit: limit(20, 100),
    brand_id: z.number().int().positive().optional().describe("Brand (producer) id from list_category_filters"),
    ...listingFilters,
});

export const CATEGORY_LISTING_INPUT = z.object({
    category_id: z
        .number()
        .int()
        .positive()
        .describe("Category id (get_category, autocomplete or a product's category)"),
    page: z.number().int().min(1).optional().describe("First page, 1-based"),
    skip,
    limit: limit(24, 200),
    brand_id: z.number().int().positive().optional().describe("Brand id from list_category_filters"),
    filters: z
        .array(z.object({ param_id: z.number().int(), value_id: z.number().int() }))
        .optional()
        .describe("Parameter filters from list_category_filters, e.g. [{param_id: 15361, value_id: 239455089}]"),
    ...listingFilters,
});

const pcRole = z.enum(PC_ROLES);
const pcPart = z.object({
    code: z.string().min(1).describe("Alza product code (e.g. 'BD750m7b1'), numeric id or product URL"),
    role: pcRole.optional().describe("Component role; detected from the spec table when omitted"),
});
const psuHeadroom = z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("PSU headroom over the estimated peak draw (default 0.3)");

export const PC_SUGGEST_PROFILES = ["gaming", "workstation", "office"] as const;
export const PC_CPU_VENDORS = ["amd", "intel"] as const;

export const ALZA_OPERATIONS: AlzaOperation[] = [
    operation({
        name: "search_products",
        description:
            "Search the Alza catalog by keywords. Returns code, id, price, original price and discount, rating with count, stock and the price badge (e.g. BLACK FRIDAY -19 %). Sorting is server-side.",
        input: SEARCH_INPUT,
        run: async (api, i) => {
            const data = await searchProducts(api, {
                term: i.query,
                sort: i.sort,
                page: i.page,
                limit: i.limit,
                skip: i.skip,
                brandId: i.brand_id,
                minPrice: i.min_price,
                maxPrice: i.max_price,
                inStock: i.in_stock,
                discounted: i.discounted,
            });
            return { data, markdown: listingMarkdown(`Search "${i.query}"`, data) };
        },
    }),
    operation({
        name: "list_category",
        description:
            "List the products of an Alza category, optionally filtered by brand and parameter values (ids from list_category_filters).",
        input: CATEGORY_LISTING_INPUT,
        run: async (api, i) => {
            const data = await listCategory(api, {
                categoryId: i.category_id,
                page: i.page,
                limit: i.limit,
                skip: i.skip,
                brandId: i.brand_id,
                params: i.filters?.map((f) => ({ paramId: f.param_id, valueId: f.value_id })),
                minPrice: i.min_price,
                maxPrice: i.max_price,
                inStock: i.in_stock,
                discounted: i.discounted,
            });
            return { data, markdown: listingMarkdown(`Category ${i.category_id}`, data) };
        },
    }),
    operation({
        name: "get_product",
        description:
            "Full detail of one product: price and discount, rating, stock and delivery, warranty, EAN, category, image URLs and the complete parameter table.",
        input: z.object({ product }),
        run: async (api, i) => {
            const data = await getProduct(api, i.product);
            return { data, markdown: productMarkdown(data) };
        },
    }),
    operation({
        name: "get_reviews",
        description:
            "All customer reviews of a product (text, pros, cons, stars, date, verified purchase, country), newest first, with the star distribution.",
        input: z.object({ product, limit: limit(50, 500) }),
        run: async (api, i) => {
            const data = await getReviews(api, i.product, { limit: i.limit });
            return { data, markdown: reviewsMarkdown(data) };
        },
    }),
    operation({
        name: "get_questions",
        description: "Customer questions about a product with the answers from Alza, the maker and other buyers.",
        input: z.object({
            product,
            limit: limit(25, 200),
            answers: z.boolean().optional().describe("Fetch the answers too (default true)"),
        }),
        run: async (api, i) => {
            const data = await getQuestions(api, i.product, { limit: i.limit, answers: i.answers });
            return { data, markdown: questionsMarkdown(data) };
        },
    }),
    operation({
        name: "compare_products",
        description: "Compare 2 to 6 products side by side: price, rating, stock, warranty and every parameter.",
        input: z.object({ products: z.array(product).min(2).max(6).describe("Products to compare") }),
        run: async (api, i) => {
            const data = await compareProducts(api, i.products);
            return { data, markdown: compareMarkdown(data) };
        },
    }),
    operation({
        name: "recommend_alternatives",
        description:
            "Alternatives to a product: Alza's own list, or else the best-rated other products of its category (`source` says which).",
        input: z.object({ product, limit: limit(10, 50) }),
        run: async (api, i) => {
            const data = await getAlternatives(api, i.product, { limit: i.limit });
            const title = `Alternatives to ${data.product.name} (${data.source === "alza" ? "Alza's list" : "best rated in its category"})`;
            return { data, markdown: listingMarkdown(title, { page: 0, hasMore: false, items: data.items }) };
        },
    }),
    operation({
        name: "autocomplete",
        description: "Search-box suggestions: phrases, products, categories (with ids) and brands for a partial query.",
        input: z.object({ query: z.string().min(1).describe("Partial search text") }),
        run: async (api, i) => {
            const data = await autocomplete(api, i.query);
            return { data, markdown: suggestionsMarkdown(data) };
        },
    }),
    operation({
        name: "get_category",
        description: "A category's name, breadcrumb path and subcategories (with ids).",
        input: z.object({ category_id: z.number().int().positive().describe("Category id") }),
        run: async (api, i) => {
            const data = await getCategory(api, i.category_id);
            return { data, markdown: categoryMarkdown(data) };
        },
    }),
    operation({
        name: "list_category_filters",
        description:
            "The filters of a category: brands (ids for brand_id) and parameter facets (param_id and value_id for list_category).",
        input: z.object({ category_id: z.number().int().positive().describe("Category id") }),
        run: async (api, i) => {
            const data = await getCategoryFilters(api, i.category_id);
            return { data, markdown: filtersMarkdown(data) };
        },
    }),
    operation({
        name: "get_deals",
        description: "Discounted products of a search or a category, the biggest discount first.",
        input: z.object({
            query: z.string().min(1).optional().describe("Search words (or pass category_id)"),
            category_id: z.number().int().positive().optional().describe("Category id (or pass query)"),
            min_discount: z.number().min(1).max(99).optional().describe("Smallest discount in percent (default 1)"),
            limit: limit(30, 200),
            pages: z.number().int().min(1).max(20).optional().describe("Result pages to scan (default 4)"),
        }),
        run: async (api, i) => {
            const data = await getDeals(api, {
                term: i.query,
                categoryId: i.category_id,
                minDiscount: i.min_discount,
                limit: i.limit,
                pages: i.pages,
            });
            return {
                data,
                markdown: listingMarkdown(`Deals in ${i.query ? `"${i.query}"` : `category ${i.category_id}`}`, data),
            };
        },
    }),
    operation({
        name: "find_by_ean",
        description: "Find products by EAN barcode.",
        input: z.object({
            eans: z
                .array(z.string().regex(/^\d{8,14}$/))
                .min(1)
                .max(20)
                .describe("EAN codes"),
        }),
        run: async (api, i) => {
            const data = await productsByEan(api, i.eans);
            const markdown = data
                .map((row) =>
                    row.product
                        ? `- ${row.ean}: **${row.product.name}** \`${row.product.code}\` ${row.product.url}`
                        : `- ${row.ean}: not found`
                )
                .join("\n");
            return { data, markdown };
        },
    }),
    operation({
        name: "price_history",
        description:
            "A product's price history from Hlídač shopů: lowest and highest price with dates, the lowest price of the last 30 days, the claimed and the real discount.",
        input: z.object({ product }),
        run: async (api, i) => {
            const data = await getPriceHistory(api, i.product);
            return { data, markdown: historyMarkdown(data, api.storefront.currency) };
        },
    }),
    operation({
        name: "list_categories",
        description:
            "Browse the category tree one level at a time: without parent_id the top level, else the children of that category (ids for list_category and get_category).",
        input: z.object({
            parent_id: z.number().int().positive().optional().describe("Parent category id; omit for the top level"),
        }),
        run: async (api, i) => {
            const data = await listCategories(api, i.parent_id);
            return { data, markdown: categoriesMarkdown(data) };
        },
    }),
    operation({
        name: "pc_build_check",
        description: `Check a PC parts list for compatibility: CPU socket, RAM generation and slots, PSU wattage, GPU length and cooler clearance in the case, cooler socket, board and PSU form factor, display output. 1-${MAX_CHECK_PARTS} parts, one product read each.`,
        input: z.object({
            parts: z
                .array(pcPart)
                .min(1)
                .max(MAX_CHECK_PARTS)
                .describe("The build's parts; ram and storage may repeat"),
            psu_headroom: psuHeadroom,
        }),
        run: async (api, i) => {
            const data = await new PcBuilder(alzaPcCatalog(api)).check({ parts: i.parts, psuHeadroom: i.psu_headroom });
            return { data, markdown: buildReportMarkdown(data, "PC build check") };
        },
    }),
    operation({
        name: "pc_build_suggest",
        description:
            "Suggest a compatibility-checked PC parts list within a CZK budget from live Alza listings: cpu, motherboard, ram, gpu, storage, case, cooler, psu. Czech storefront only (the budget is CZK). Slow: one category page per role plus bounded product reads.",
        input: z.object({
            budget: z.number().int().min(8000).max(500000).describe("Total budget in CZK, fixed parts included"),
            profile: z
                .enum(PC_SUGGEST_PROFILES)
                .optional()
                .describe("gaming (default, GPU-heavy), workstation, office (no GPU)"),
            cpu_vendor: z.enum(PC_CPU_VENDORS).optional().describe("Only AMD or only Intel CPUs"),
            fixed_parts: z
                .array(pcPart)
                .max(6)
                .optional()
                .describe("Parts already chosen; the rest is picked to fit them"),
            skip_roles: z.array(pcRole).optional().describe("Roles to leave out, e.g. ['storage']"),
            max_detail_fetches: z
                .number()
                .int()
                .min(1)
                .max(MAX_DETAIL_FETCHES)
                .optional()
                .describe(`Upper bound on product reads (default ${DEFAULT_MAX_DETAIL_FETCHES})`),
            psu_headroom: psuHeadroom,
        }),
        run: async (api, i) => {
            // The budget and the profile splits are CZK amounts; another storefront prices in EUR or HUF.
            if (api.storefront.currency !== "CZK") {
                throw new Error(
                    `pc_build_suggest takes a CZK budget and compares it with listing prices, so it runs on the cz storefront only; this one (${api.storefront.id}) prices in ${api.storefront.currency}.`
                );
            }

            const data = await new PcBuilder(alzaPcCatalog(api)).suggest({
                budget: i.budget,
                profile: i.profile,
                cpuVendor: i.cpu_vendor,
                fixedParts: i.fixed_parts,
                skipRoles: i.skip_roles,
                maxDetailFetches: i.max_detail_fetches,
                psuHeadroom: i.psu_headroom,
            });
            return { data, markdown: buildReportMarkdown(data, `PC build for ${i.budget} CZK`) };
        },
    }),
    operation({
        name: "find_pickup_points",
        description: "The AlzaBox lockers nearest to a postal code, a place name or 'lat,lon'.",
        input: z.object({
            near: z.string().min(1).describe("Postal code (11000), place name (Brno) or 'lat,lon'"),
            limit: limit(10, 100),
        }),
        run: async (api, i) => {
            const data = await findPickupPoints(api, { near: i.near, limit: i.limit });
            return { data, markdown: pickupMarkdown(data.center, data.places) };
        },
    }),
];

export function findOperation(name: string): AlzaOperation {
    const op = ALZA_OPERATIONS.find((candidate) => candidate.name === name);
    if (!op) {
        throw new Error(`Unknown Alza operation: ${name}`);
    }

    return op;
}
