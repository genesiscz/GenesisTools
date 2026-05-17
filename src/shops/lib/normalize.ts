import { SafeJSON } from "@app/utils/json";
import { removeDiacritics } from "@app/utils/string";

export type Unit = "g" | "kg" | "ml" | "l" | "ks" | "m" | "m2";

const FLAVOR_MAP: Array<[RegExp, string]> = [
    [/(ml[eé]čn[áéa]|milk)/iu, "milk"],
    [/(ho[řr]k[áéa]|dark)/iu, "dark"],
    [/(b[íi]l[áéa]|white)/iu, "white"],
    [/(jahod[oa]v[áéa]|strawberry)/iu, "strawberry"],
    [/(vanilkov[áéa]|vanilla)/iu, "vanilla"],
    [/(o[řr][íi][šs]kov[áéa]|hazelnut)/iu, "hazelnut"],
    [/(karamelov[áéa]|caramel)/iu, "caramel"],
    [/(kokosov[áéa]|coconut)/iu, "coconut"],
    [/(mandlov[áéa]|almond)/iu, "almond"],
];

const UNIT_ALIASES: Array<[RegExp, Unit]> = [
    [/^(kilogram[uůy]?|kg)$/i, "kg"],
    [/^(gram[uůy]?|g)$/i, "g"],
    [/^(litr[uůy]?|l)$/i, "l"],
    [/^(mililitr[uůy]?|ml)$/i, "ml"],
    [/^(kus[uy]?|ks)$/i, "ks"],
    [/^(metr[uůy]?|m)$/i, "m"],
    [/^(m2|m\^2)$/i, "m2"],
];

export function parseUnit(raw: string): Unit | null {
    const trimmed = raw.trim();
    for (const [pattern, unit] of UNIT_ALIASES) {
        if (pattern.test(trimmed)) {
            return unit;
        }
    }

    return null;
}

export function normalizeText(s: string): string {
    return removeDiacritics(s).toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeBrand(brand: string | null): string | null {
    if (!brand) {
        return null;
    }

    const stripped = removeDiacritics(brand).toLowerCase().trim();
    if (stripped.length === 0) {
        return null;
    }

    return stripped.replace(/\s+/g, " ");
}

export function normalizeName(name: string): string {
    return removeDiacritics(name)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}%.,\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

const SIZE_RE =
    /(\d+(?:[.,]\d+)?)\s*(kilogram[uůy]?|gram[uůy]?|litr[uůy]?|mililitr[uůy]?|kus[uy]?|kg|g|ml|l|ks|m2|m\^2|m)\b/giu;

export function extractSize(name: string): { unit: Unit; unitAmount: number } | null {
    const matches = [...name.matchAll(SIZE_RE)];
    if (matches.length === 0) {
        return null;
    }

    const last = matches[matches.length - 1];
    const amount = Number.parseFloat(last[1].replace(",", "."));
    const unit = parseUnit(last[2]);
    if (unit === null || Number.isNaN(amount)) {
        return null;
    }

    return { unit, unitAmount: amount };
}

const PACK_PATTERNS: RegExp[] = [
    /(\d+)\s*[×x]\s*\d/iu,
    /(\d+)\s*[×x](?:\s|$)/iu,
    /[×x]\s*(\d+)\b/iu,
    /(\d+)\s*(?:ks|kus[uy]?)\s+balen[íi]/iu,
    /(\d+)\s*pcs\b/i,
    /(\d+)\s*-?\s*pack\b/i,
];

export function extractPackCount(name: string): number | null {
    for (const pattern of PACK_PATTERNS) {
        const match = name.match(pattern);
        if (match) {
            const count = Number.parseInt(match[1], 10);
            if (!Number.isNaN(count) && count > 1) {
                return count;
            }
        }
    }

    return null;
}

export function extractFlavorKey(name: string, attributes?: Record<string, unknown>): string | null {
    const haystack = attributes ? `${name} ${SafeJSON.stringify(attributes)}` : name;
    for (const [pattern, key] of FLAVOR_MAP) {
        if (pattern.test(haystack)) {
            return key;
        }
    }

    return null;
}
