// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/itesco-daily/main.js

export interface ItescoDiscoverJson {
    "mfe-orchestrator"?: {
        props?: {
            apolloCache?: ItescoApolloCache;
        };
    };
    [key: string]: unknown;
}

export type ItescoApolloCache = Record<string, ItescoApolloEntry>;

export interface ItescoApolloEntry {
    id?: string | number;
    title?: string;
    defaultImageUrl?: string;
    status?: string;
    price?: {
        actual?: number;
        unitPrice?: number;
    };
    promotions?: Array<{ __ref?: string } | string | null>;
    displayType?: string;
    productType?: string;
    description?: string;
    info?: {
        total?: number;
        count?: number;
    };
    [key: string]: unknown;
}

export interface ItescoBreadcrumbNode {
    text?: string;
    current?: boolean;
    children?: ItescoBreadcrumbNode[];
}

export interface ItescoPageInfo {
    total: number;
    pageSize: number;
}

export const ITESCO_BASE_URL = "https://nakup.itesco.cz";
export const ITESCO_HOME_URL = "https://nakup.itesco.cz/groceries/cs-CZ/";
export const ITESCO_LOCALE = "cs-CZ";
export const ITESCO_BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
export const ITESCO_SUPERDEPT_REGEX =
    /^(?:https?:\/\/[^/]+)?(\/groceries\/cs-CZ\/shop\/[^/?#]+\/all)(?:[?#]|$)/;
export const ITESCO_CZ_SALE_REGEX = /předtím\s+([\d,.]+)\s*Kč/;
export const ITESCO_DEFAULT_PAGE_SIZE = 24;
