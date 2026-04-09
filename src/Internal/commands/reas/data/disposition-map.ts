// Canonical Czech flat disposition codes
export const DISPOSITIONS = [
    "1+kk",
    "1+1",
    "2+kk",
    "2+1",
    "3+kk",
    "3+1",
    "4+kk",
    "4+1",
    "5+kk",
    "5+1",
    "6+kk",
    "6+1",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

// Sreality category_sub_cb codes
const SREALITY_DISPOSITION_MAP: Record<string, number> = {
    "1+kk": 2,
    "1+1": 3,
    "2+kk": 4,
    "2+1": 5,
    "3+kk": 6,
    "3+1": 7,
    "4+kk": 8,
    "4+1": 9,
    "5+kk": 10,
    "5+1": 11,
    "6+kk": 12,
    "6+1": 47,
};

const ALIASES: Record<string, string> = {
    garsoniera: "1+kk",
    garsoniéra: "1+kk",
    garsonka: "1+kk",
    atypický: "other",
    atypicky: "other",
};

export function normalizeDisposition(raw: string): string {
    const lower = raw.toLowerCase().trim();

    if (ALIASES[lower]) {
        return ALIASES[lower];
    }

    // Strip internal whitespace around "+" for patterns like "2 + kk" → "2+kk"
    const collapsed = lower.replace(/\s*\+\s*/g, "+");
    const match = collapsed.match(/^(\d)\+(\d|kk)$/);

    if (match) {
        return `${match[1]}+${match[2]}`;
    }

    return lower;
}

export function getSrealityCategorySubCb(disposition: string): number | undefined {
    return SREALITY_DISPOSITION_MAP[normalizeDisposition(disposition)];
}
