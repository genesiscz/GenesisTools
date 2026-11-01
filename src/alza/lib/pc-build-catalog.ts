import { logger } from "@genesiscz/utils/logger";
import type { AlzaApi } from "./api";
import { getCategoryFilters, getProduct, listCategory } from "./catalog";
import type { PcCatalog, Product } from "./pc-build-service";
import type { ProductDetail, ProductSummary } from "./types";

/**
 * The PC builder's three catalog reads over AlzaApi: a product detail (the JSON product route, whose parameter rows
 * carry the same Czech names the reference read from the product page), one category listing page, and a category's
 * brand facet. Details are cached for the life of the adapter, so a suggest run never loads a product twice.
 */

function fromSummary(item: ProductSummary): Product {
    return {
        code: item.code,
        name: item.name,
        url: item.url,
        price: item.price,
        currency: item.currency,
        availability: item.availability,
        inStock: item.inStock,
    };
}

function fromDetail(detail: ProductDetail): Product {
    return {
        ...fromSummary(detail),
        params: detail.params.map((p) => ({ name: p.name, value: p.values.join(", ") })),
    };
}

export function alzaPcCatalog(api: AlzaApi): PcCatalog {
    const details = new Map<string, Promise<Product>>();
    return {
        getProductSpecs: (code) => {
            const key = code.trim().toLowerCase();
            let pending = details.get(key);
            if (!pending) {
                pending = getProduct(api, code).then(fromDetail);
                pending.catch((error: unknown) => {
                    logger.debug({ error, code }, "alza pc-build product read failed");
                    details.delete(key);
                });
                details.set(key, pending);
            }

            return pending;
        },
        searchProducts: async (opts) => {
            const page = await listCategory(api, {
                categoryId: opts.categoryId,
                inStock: opts.inStock,
                limit: opts.limit,
                brandId: opts.producerIds?.[0],
            });
            return { products: page.items.map(fromSummary) };
        },
        getCategoryFilters: async (categoryId) => {
            const filters = await getCategoryFilters(api, categoryId);
            return { brands: filters.brands.map((b) => ({ description: b.name, valueId: b.id })) };
        },
    };
}
