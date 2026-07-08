export interface ProbeArgs {
    source: string;
    primary: RegExp;
    secondary: RegExp[];
    before?: number;
    after?: number;
}

export interface ProbeResult {
    matched: boolean;
    windows: string[];
}

/**
 * For each match of `primary`, take the window [match.start - before, match.end + after] and
 * test whether EVERY `secondary` regex matches inside that single window. Runs on raw minified
 * text — no beautify required, which keeps bisect at download+extract cost per version.
 */
export function probeCooccurrence({ source, primary, secondary, before = 800, after = 200 }: ProbeArgs): ProbeResult {
    const re = new RegExp(primary.source, primary.flags.includes("g") ? primary.flags : `${primary.flags}g`);
    const windows: string[] = [];

    for (const match of source.matchAll(re)) {
        const start = Math.max(0, (match.index ?? 0) - before);
        const end = Math.min(source.length, (match.index ?? 0) + match[0].length + after);
        const window = source.slice(start, end);

        if (secondary.every((s) => s.test(window))) {
            windows.push(window);
        }
    }

    return { matched: windows.length > 0, windows };
}
