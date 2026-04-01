import * as p from "@clack/prompts";

export function collectKeyValue(value: string, prev: string[]): string[] {
    return [...prev, value];
}

export function parseKeyValuePairs(pairs: string[], flagName: string): Map<string, string> {
    const map = new Map<string, string>();

    for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid ${flagName} format: "${pair}". Expected "label=command".`);
            process.exit(1);
        }

        map.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
    }

    return map;
}
