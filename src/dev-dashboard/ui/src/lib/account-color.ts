/**
 * One stable colour per account, used by chips, chart lines, stacked areas and
 * card headers, so the same account looks the same everywhere on the page.
 * Twelve hues spaced around the wheel, all tuned to read on the dd dark panel.
 */
export const ACCOUNT_PALETTE: readonly string[] = [
    "#34d399", // emerald (the dd accent)
    "#60a5fa", // blue
    "#f472b6", // pink
    "#fbbf24", // amber
    "#a78bfa", // violet
    "#22d3ee", // cyan
    "#f97316", // orange
    "#84cc16", // lime
    "#e879f9", // fuchsia
    "#2dd4bf", // teal
    "#fb7185", // rose
    "#facc15", // yellow
];

export function hashString(input: string): number {
    let h = 0;

    for (let i = 0; i < input.length; i++) {
        h = (h * 31 + input.charCodeAt(i)) >>> 0;
    }

    return h;
}

export function accountColor(accountId: string): string {
    return ACCOUNT_PALETTE[hashString(accountId) % ACCOUNT_PALETTE.length];
}

/**
 * Assign colours to a list of accounts without collisions while the list fits
 * the palette: each account keeps its hashed hue unless another account already
 * took it, in which case it moves to the next free one. Deterministic for a
 * given ordered list, which is what a legend needs.
 */
export function assignAccountColors(accountIds: readonly string[]): Record<string, string> {
    const taken = new Set<number>();
    const result: Record<string, string> = {};

    for (const id of accountIds) {
        let index = hashString(id) % ACCOUNT_PALETTE.length;
        let attempts = 0;

        while (taken.has(index) && attempts < ACCOUNT_PALETTE.length) {
            index = (index + 1) % ACCOUNT_PALETTE.length;
            attempts++;
        }

        taken.add(index);
        result[id] = ACCOUNT_PALETTE[index];
    }

    return result;
}
