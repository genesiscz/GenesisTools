import type { ProviderName } from "@app/Internal/commands/reas/types";

export interface ProviderBrowseLink {
    provider: ProviderName;
    label: string;
    kind: "listing" | "search";
    url: string;
}

export function detectProviderFromUrl(value: string): ProviderName | null {
    try {
        const hostname = new URL(value).hostname.toLowerCase();

        if (hostname.includes("sreality")) {
            return "sreality";
        }

        if (hostname.includes("bezrealitky")) {
            return "bezrealitky";
        }

        if (hostname.includes("ereality")) {
            return "ereality";
        }

        if (hostname.includes("reas")) {
            return "reas";
        }

        return null;
    } catch {
        return null;
    }
}

export function buildProviderBrowseLinks(options: {
    district: string;
    listingUrl?: string | null;
    providers?: ProviderName[];
}): ProviderBrowseLink[] {
    const providers = options.providers ?? [];
    const listingProvider = options.listingUrl ? detectProviderFromUrl(options.listingUrl) : null;

    return providers.map((provider) => {
        if (listingProvider === provider && options.listingUrl) {
            return {
                provider,
                label: `${getProviderLabel(provider)} listing`,
                kind: "listing",
                url: options.listingUrl,
            };
        }

        return {
            provider,
            label: `${getProviderLabel(provider)} search`,
            kind: "search",
            url: buildProviderSearchUrl({ district: options.district, provider }),
        };
    });
}

function buildProviderSearchUrl(options: { district: string; provider: ProviderName }): string {
    const districtSlug = toSlug(options.district);

    if (options.provider === "sreality") {
        return `https://www.sreality.cz/hledani/pronajem/byty/${districtSlug}`;
    }

    if (options.provider === "bezrealitky") {
        return `https://www.bezrealitky.cz/hledani/pronajem/byt?query=${encodeURIComponent(options.district)}`;
    }

    if (options.provider === "ereality") {
        return `https://www.ereality.cz/pronajem/byty/${districtSlug}?pg=0`;
    }

    if (options.provider === "reas") {
        return "https://reas.cz/";
    }

    return "https://www.mfcr.cz/cs/rozvoj-a-rust/trh-nemovitosti/cenova-mapa-najemniho-bydleni";
}

function getProviderLabel(provider: ProviderName): string {
    if (provider === "mf") {
        return "MF";
    }

    if (provider === "reas") {
        return "REAS";
    }

    return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function toSlug(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
