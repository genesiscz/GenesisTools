// Tool-agnostic failure markers. Each term should appear across at least two
// unrelated build/package/language ecosystems so the pattern doesn't bias
// toward one stack. Case-insensitive so we catch `Failed`, `error:`, etc.
// from tools that don't shout in ALL CAPS (clang/cmake/rustc/pnpm all emit
// lowercase `error:`; pnpm/yarn emit `Failed to ...`).
const DEFAULT_PATTERN =
    /\bFAIL(?:ED|URE)?\b|✗|\bERROR\b|\bException\b|\bfatal\b|error TS\d+|exit code [1-9]\d*|ELIFECYCLE|npm ERR|\bERR_\w+|Error:|Caused by|Execution failed|What went wrong|BUILD FAILED|FAILURE:/i;

export interface ErrorBlock {
    line: number;
    matched: string;
    window: string[];
}

export interface ExtractOpts {
    pattern?: RegExp;
    /** Cap total blocks (default 5). */
    maxBlocks?: number;
}

export function extractErrors(text: string, opts: ExtractOpts = {}): ErrorBlock[] {
    const lines = text.split("\n");
    const re = opts.pattern ?? DEFAULT_PATTERN;
    const maxBlocks = opts.maxBlocks ?? 5;
    const context = lines.length > 100 ? 3 : 5;

    const matches: number[] = [];

    for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;

        if (re.test(lines[i])) {
            matches.push(i);
        }
    }

    if (matches.length === 0) {
        return [];
    }

    type Range = { matchIdx: number; from: number; to: number };
    const ranges: Range[] = [];

    for (const idx of matches) {
        const from = Math.max(0, idx - context);
        const to = Math.min(lines.length - 1, idx + context);
        const last = ranges[ranges.length - 1];

        if (last && from <= last.to + 1) {
            last.to = Math.max(last.to, to);
        } else {
            ranges.push({ matchIdx: idx, from, to });
        }
    }

    return ranges.slice(0, maxBlocks).map((r) => ({
        line: r.matchIdx + 1,
        matched: lines[r.matchIdx],
        window: lines.slice(r.from, r.to + 1),
    }));
}
