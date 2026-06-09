export function collectKeyValue(value: string, prev: string[]): string[] {
    return [...prev, value];
}

export function parseKeyValuePairs(pairs: string[], flagName: string): Map<string, string> {
    const map = new Map<string, string>();

    for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");

        if (eqIdx === -1) {
            throw new Error(`Invalid ${flagName} format: "${pair}". Expected "label=command".`);
        }

        map.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
    }

    return map;
}
