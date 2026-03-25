import { createColors } from "picocolors";

const pc = createColors(true);

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseQueryWords(query: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const raw of query.split(/\s+/)) {
        const word = raw.toLowerCase();

        if (word.length <= 2) {
            continue;
        }

        if (seen.has(word)) {
            continue;
        }

        seen.add(word);
        result.push(word);
    }

    return result;
}

export function highlightQueryWords(text: string, words: string[]): string {
    if (!text || words.length === 0) {
        return text;
    }

    const pattern = words.map(escapeRegex).join("|");
    const regex = new RegExp(`(${pattern})`, "gi");

    return text.replace(regex, (match) => pc.bold(pc.yellow(match)));
}
