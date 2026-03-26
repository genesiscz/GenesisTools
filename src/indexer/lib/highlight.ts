import pc from "picocolors";

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

interface HighlightColors {
    bold: (s: string) => string;
    yellow: (s: string) => string;
}

export function highlightQueryWords(text: string, words: string[], colors?: HighlightColors): string {
    if (!text || words.length === 0) {
        return text;
    }

    const { bold, yellow } = colors ?? pc;

    const pattern = [...words]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join("|");
    const regex = new RegExp(`(${pattern})`, "gi");

    return text.replace(regex, (match) => bold(yellow(match)));
}
