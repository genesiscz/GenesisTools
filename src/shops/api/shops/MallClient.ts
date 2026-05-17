import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type { MallCountryConfig } from "@app/shops/api/shops/MallClient.types";

const COUNTRY_CZ: MallCountryConfig = { tld: "cz", currency: "CZK" };

const DEPRECATION_MESSAGE =
    "mall.cz was acquired by Allegro in 2025; the standalone shop is offline. " +
    "See https://allegro.cz/obchod/mall-cz for the merchant's Allegro storefront.";

export interface MallClientConfig extends ShopApiClientConstructorConfig {
    country?: MallCountryConfig;
}

export class MallClient extends ShopApiClient {
    readonly shopOrigin: "mall.cz" | "mall.sk";
    readonly displayName = "Mall.cz";
    readonly currency: "CZK" | "EUR";
    readonly capabilities: ShopCapabilities = {
        live: false,
        history: false,
        listing: false,
        ean: false,
        search: false,
        botProtection: "none",
    };

    constructor(config: MallClientConfig = {}) {
        const country = config.country ?? COUNTRY_CZ;
        super({
            baseUrl: `https://www.mall.${country.tld}`,
            loggerContext: { provider: `mall-${country.tld}` },
            ...config,
        });
        this.currency = country.currency;
        this.shopOrigin = `mall.${country.tld}`;
    }

    async getProduct(_input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        throw new Error(DEPRECATION_MESSAGE);
    }

    // biome-ignore lint/correctness/useYield: deprecated shop — listing always throws before yielding.
    async *listCategory(_opts: ListingOptions): AsyncIterable<RawProduct> {
        throw new Error(DEPRECATION_MESSAGE);
    }

    async listCategories(): Promise<Category[]> {
        return [];
    }
}
