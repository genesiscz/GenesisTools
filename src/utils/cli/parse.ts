/** Parses a CLI flag value as a non-negative integer, rejecting anything else with a clear error. */
export function parseNonNegativeInt(value: string, flag: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
    }

    const parsed = Number.parseInt(value, 10);

    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
    }

    return parsed;
}

/**
 * Splits a command line into argv words, keeping a single- or double-quoted part as one word
 * (`tools a "b c"` is ["tools", "a", "b c"]). No expansion: `$HOME` and globs stay as written.
 * An unclosed quote throws, so a broken command is reported instead of run with shifted words.
 */
export function commandWords(line: string): string[] {
    const words: string[] = [];
    let word = "";
    let inWord = false;
    let quote: "'" | '"' | null = null;

    for (const char of line) {
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                word += char;
            }

            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            inWord = true;
            continue;
        }

        if (/\s/.test(char)) {
            if (inWord) {
                words.push(word);
                word = "";
                inWord = false;
            }

            continue;
        }

        word += char;
        inWord = true;
    }

    if (quote) {
        throw new Error(`unclosed ${quote} in command: ${line}`);
    }

    if (inWord) {
        words.push(word);
    }

    return words;
}
