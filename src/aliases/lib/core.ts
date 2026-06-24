/**
 * Pure, testable cores for the `aliases` tool.
 *
 * Everything in this file is a pure function: no filesystem, no clock, no
 * environment. The clock-dependent value (`daysSince`, `now`) is always
 * injected by the caller so the cores stay deterministic under test.
 */

export interface HotPath {
    commands: string[];
    count: number;
    score: number;
}

export interface AliasSuggestion {
    name: string;
    command: string;
}

export type HistoryFormat = "zsh" | "bash" | "auto";

/**
 * Marker comments delimiting the managed alias block in a shell rc file.
 * They are stable so `upsertManagedBlock` can find and replace an existing
 * block on a re-apply (idempotency).
 */
export const BLOCK_START = "# >>> aliases managed block >>>";
export const BLOCK_END = "# <<< aliases managed block <<<";

/**
 * Parse raw shell history text into an ordered array of command strings.
 *
 * - zsh extended-history lines look like `: 1700000000:0;git status` — the
 *   `: <ts>:<elapsed>;` prefix is stripped and the command kept. Plain lines
 *   without the prefix are kept verbatim.
 * - bash lines are one command per line; `HISTTIMEFORMAT` timestamp lines
 *   (a leading `#` followed by only digits) are dropped.
 * - Multi-line zsh entries (a trailing `\` on a line is the continuation
 *   marker; the next physical line is part of the same command) are coalesced
 *   into a single entry. Each embedded newline is replaced with a space so the
 *   result is a single command string. Without this, pasted multi-line content
 *   (crash traces, heredocs, jq filter chains) gets shredded into fake
 *   "commands" whose continuation lines repeat across pastes and pollute the
 *   n-gram hot-path detection.
 * - Blank lines are skipped; leading/trailing whitespace is trimmed.
 *
 * Pure: does not read the filesystem or the clock.
 */
export function parseHistory(raw: string, _opts: { format?: HistoryFormat } = {}): string[] {
    const merged: string[] = [];
    let buffer: string | null = null;

    // NOTE: a "smart" odd-count-trailing-backslash check (so `echo \\` isn't
    // treated as a continuation) was tried and reverted — zsh stores embedded
    // newlines as `\\\n` (TWO backslashes + LF byte), so an even count of
    // trailing backslashes is the normal continuation case in this file
    // format, not the literal-backslash exception. Treating any trailing `\`
    // as continuation is the empirically-correct rule for both zsh ext-history
    // and the same-shape encoding bash uses.

    for (const rawLine of raw.split("\n")) {
        if (buffer !== null) {
            // We're inside a continuation. The previous buffer ends with `\`,
            // which encodes an embedded newline; drop it and join with a space
            // so the result stays single-line.
            buffer = `${buffer.slice(0, -1)} ${rawLine}`;
        } else {
            buffer = rawLine;
        }

        if (buffer.endsWith("\\")) {
            continue;
        }

        merged.push(buffer);
        buffer = null;
    }

    if (buffer !== null) {
        // File ended mid-continuation; keep whatever we have without the
        // dangling backslash.
        merged.push(buffer.endsWith("\\") ? buffer.slice(0, -1) : buffer);
    }

    const out: string[] = [];

    for (const rawLine of merged) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }

        // bash HISTTIMEFORMAT marker: `#1700000000` (hash + digits only).
        if (/^#\d+$/.test(line)) {
            continue;
        }

        // zsh extended format: `: <epoch>:<elapsed>;<command>`.
        const zshMatch = /^:\s*\d+:\d+;(.*)$/.exec(line);
        if (zshMatch) {
            const command = zshMatch[1].trim();
            if (command.length > 0) {
                out.push(command);
            }

            continue;
        }

        out.push(line);
    }

    return out;
}

function ngramKey(commands: string[]): string {
    return commands.join(" ");
}

/**
 * Test whether `inner` appears as a contiguous slice of `outer`.
 */
function isContiguousSlice(outer: string[], inner: string[]): boolean {
    if (inner.length === 0 || inner.length > outer.length) {
        return false;
    }

    for (let i = 0; i + inner.length <= outer.length; i++) {
        let match = true;
        for (let j = 0; j < inner.length; j++) {
            if (outer[i + j] !== inner[j]) {
                match = false;
                break;
            }
        }

        if (match) {
            return true;
        }
    }

    return false;
}

/**
 * Extract frequently-repeated consecutive command n-grams ("hot commands").
 *
 * For every window length n in [minN, maxN], slide over the ordered command
 * array, count distinct consecutive n-grams, keep those with count >=
 * threshold, score them by `count * n`, drop shorter equal-count n-grams that
 * are fully subsumed by a longer hot one, then return the top `top` ranked.
 *
 * Pure: no filesystem, no clock. Deterministic ordering (score desc, then
 * count desc, then key lexicographically).
 */
export function extractHotPaths(input: {
    commands: string[];
    minN?: number;
    maxN?: number;
    /** Minimum count for single-command (n=1) candidates. */
    threshold?: number;
    /** Minimum count for chain (n>=2) candidates. Defaults to `threshold`. */
    chainThreshold?: number;
    top?: number;
}): HotPath[] {
    const commands = input.commands;
    const minN = Math.max(1, input.minN ?? 2);
    const maxN = Math.max(minN, input.maxN ?? 4);
    const threshold = Math.max(1, input.threshold ?? 3);
    const chainThreshold = Math.max(1, input.chainThreshold ?? threshold);
    const top = Math.max(0, input.top ?? 20);

    const counts = new Map<string, { commands: string[]; count: number }>();

    for (let n = minN; n <= maxN; n++) {
        if (commands.length < n) {
            continue;
        }

        for (let i = 0; i + n <= commands.length; i++) {
            const window = commands.slice(i, i + n);
            const key = ngramKey(window);
            const existing = counts.get(key);
            if (existing) {
                existing.count += 1;
            } else {
                counts.set(key, { commands: window, count: 1 });
            }
        }
    }

    const hot: HotPath[] = [];
    for (const entry of counts.values()) {
        const minCount = entry.commands.length === 1 ? threshold : chainThreshold;
        if (entry.count >= minCount) {
            hot.push({
                commands: entry.commands,
                count: entry.count,
                score: entry.count * entry.commands.length,
            });
        }
    }

    // Subsumption: drop a shorter hot n-gram if a longer hot n-gram fully
    // contains it as a contiguous slice AND they share the same count.
    const survivors = hot.filter((candidate) => {
        return !hot.some((other) => {
            if (other === candidate) {
                return false;
            }

            if (other.commands.length <= candidate.commands.length) {
                return false;
            }

            if (other.count !== candidate.count) {
                return false;
            }

            return isContiguousSlice(other.commands, candidate.commands);
        });
    });

    survivors.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }

        if (b.count !== a.count) {
            return b.count - a.count;
        }

        return ngramKey(a.commands).localeCompare(ngramKey(b.commands));
    });

    return survivors.slice(0, top);
}

/**
 * Update a path's alias level given whether it was reused this scan and
 * how many days have passed since it was last seen.
 *
 * Decay for idle time is applied first, then growth (if reused). The level is
 * clamped to [0, max]. `daysSince` is always injected by the caller — the core
 * never reads the clock. A level decaying to 0 marks the path dead (the caller
 * decides whether to prune).
 */
export function updateLevel(input: {
    level: number;
    reused: boolean;
    daysSince: number;
    growth?: number;
    decayPerDay?: number;
    max?: number;
}): number {
    const growth = input.growth ?? 1;
    const decayPerDay = input.decayPerDay ?? 0.1;
    const max = input.max ?? 10;
    const daysSince = Math.max(0, input.daysSince);

    const decayed = Math.max(0, input.level - decayPerDay * daysSince);
    const next = input.reused ? Math.min(max, decayed + growth) : decayed;

    return Math.min(max, Math.max(0, next));
}

/**
 * Synthesize an alias for a chain of commands.
 *
 * `command` joins the chain with ` && `. `name` is a short mnemonic built from
 * the first alnum of each token: for regular tokens we use the first alnum
 * directly; for flag tokens (`-x`, `--foo`) we use the first alnum of the flag
 * NAME (after the dashes) — so `ccc --resume` aliases to `cr` (not just `c`,
 * which would happen if the flag were skipped). Empty result falls back to
 * `m<index>`. Uniqueness is enforced against the optional `taken` set by
 * appending an incrementing digit. Deterministic for the same input.
 */
export function suggestAlias(commands: string[], taken?: Set<string>, index = 0): AliasSuggestion {
    const command = commands.join(" && ");

    let base = "";
    for (const cmd of commands) {
        for (const token of cmd.split(/\s+/)) {
            if (token.length === 0) {
                continue;
            }

            // Strip leading dashes so flag NAMES contribute their first letter.
            const stem = token.replace(/^-+/, "");
            const firstAlnum = stem.toLowerCase().replace(/[^a-z0-9]/g, "")[0];
            if (firstAlnum) {
                base += firstAlnum;
            }
        }
    }

    if (base.length === 0) {
        base = `m${index}`;
    }

    let name = base;
    if (taken) {
        let suffix = 2;
        while (taken.has(name)) {
            name = `${base}${suffix}`;
            suffix += 1;
        }

        taken.add(name);
    }

    return { name, command };
}

/**
 * Decide whether an alias is actually worth showing.
 *
 * Single-command suggestions are only useful if the alias saves real typing —
 * skip the suggestion when the savings are trivial (e.g. `cd ..` → `c..` or
 * `ccc` → `c`). For multi-command chains we always keep the suggestion because
 * chaining commands is intrinsically worth aliasing.
 */
export function isWorthAliasing(input: { commands: string[]; aliasName: string }): boolean {
    if (input.commands.length >= 2) {
        return true;
    }

    const original = input.commands[0] ?? "";
    const savings = original.length - input.aliasName.length;
    return original.length >= 6 && savings >= 3;
}

/**
 * Insert or replace the managed alias block inside an rc file's contents.
 *
 * If the start/end markers already exist, everything between them (inclusive)
 * is replaced with the fresh block. Otherwise the block is appended (with a
 * leading blank line) to the end. Idempotent: applying twice yields identical
 * output. Pure string transform — no filesystem.
 */
export function upsertManagedBlock(
    rcContents: string,
    blockBody: string,
    opts: { start?: string; end?: string } = {}
): string {
    const start = opts.start ?? BLOCK_START;
    const end = opts.end ?? BLOCK_END;
    const body = blockBody.replace(/\n+$/, "");
    const block = body.length > 0 ? `${start}\n${body}\n${end}` : `${start}\n${end}`;

    const startIdx = rcContents.indexOf(start);
    const endIdx = rcContents.indexOf(end);
    const lastStartIdx = rcContents.lastIndexOf(start);
    const lastEndIdx = rcContents.lastIndexOf(end);

    if ((startIdx === -1) !== (endIdx === -1)) {
        throw new Error(
            "aliases: managed block markers are mismatched (only one of start/end found). " +
                "Fix or remove the stray marker in your rc file before re-applying."
        );
    }

    if ((startIdx !== -1 && startIdx !== lastStartIdx) || (endIdx !== -1 && endIdx !== lastEndIdx)) {
        throw new Error(
            "aliases: multiple managed block markers found; refusing to rewrite ambiguous rc file. " +
                "Remove the duplicate aliases managed block in your rc file before re-applying."
        );
    }

    if (startIdx !== -1 && endIdx !== -1) {
        if (startIdx > endIdx) {
            throw new Error("aliases: managed block start marker found after end marker; refusing to rewrite.");
        }

        const before = rcContents.slice(0, startIdx);
        const after = rcContents.slice(endIdx + end.length);
        return `${before}${block}${after}`;
    }

    if (rcContents.length === 0) {
        return `${block}\n`;
    }

    const trimmed = rcContents.replace(/\n+$/, "");
    return `${trimmed}\n\n${block}\n`;
}
