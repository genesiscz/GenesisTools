export const STOREFRONT_IDS = ["cz", "sk", "hu", "at", "de"] as const;

export type StorefrontId = (typeof STOREFRONT_IDS)[number];

export interface Storefront {
    id: StorefrontId;
    baseUrl: string;
    /** The `country` query field the webapi routes require. */
    country: string;
    acceptLanguage: string;
    currency: string;
    /** Country code Nominatim takes for a postal-code lookup. */
    geoCountry: string;
}

export const STOREFRONTS = {
    cz: {
        id: "cz",
        baseUrl: "https://www.alza.cz",
        country: "CZ",
        acceptLanguage: "cs-CZ,cs;q=0.9,en;q=0.6",
        currency: "CZK",
        geoCountry: "cz",
    },
    sk: {
        id: "sk",
        baseUrl: "https://www.alza.sk",
        country: "SK",
        acceptLanguage: "sk-SK,sk;q=0.9,en;q=0.6",
        currency: "EUR",
        geoCountry: "sk",
    },
    hu: {
        id: "hu",
        baseUrl: "https://www.alza.hu",
        country: "HU",
        acceptLanguage: "hu-HU,hu;q=0.9,en;q=0.6",
        currency: "HUF",
        geoCountry: "hu",
    },
    at: {
        id: "at",
        baseUrl: "https://www.alza.at",
        country: "AT",
        acceptLanguage: "de-AT,de;q=0.9,en;q=0.6",
        currency: "EUR",
        geoCountry: "at",
    },
    de: {
        id: "de",
        baseUrl: "https://www.alza.de",
        country: "DE",
        acceptLanguage: "de-DE,de;q=0.9,en;q=0.6",
        currency: "EUR",
        geoCountry: "de",
    },
} as const satisfies Record<StorefrontId, Storefront>;

export function isStorefrontId(value: string): value is StorefrontId {
    return (STOREFRONT_IDS as readonly string[]).includes(value);
}
