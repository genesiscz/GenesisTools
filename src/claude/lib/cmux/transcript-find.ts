/**
 * Search a live Claude Code transcript by keys, the way a person would: ctrl+o opens the transcript
 * view, `/` opens its search bar, Enter runs the search, `n` steps to the next match (wrapping).
 *
 * Measured on Claude Code 2.1.296 with CLAUDE_CODE_NO_FLICKER=1 (2026-10-15): the search covers the
 * rendered transcript only, ignores case, lands on the NEWEST match and shows `k/N` at the right
 * of the bottom line; with no hit it shows "no matches", and after Enter only the banner.
 *
 * 🛑 Every key after ctrl+o is typed only once the screen proves the transcript view is open. In the
 * normal view the same `/<text>` Enter would be submitted to the agent as a message.
 */

/** The bottom line of the transcript view, before a search runs. */
export const TRANSCRIPT_BANNER = "Showing detailed transcript";

export interface TranscriptIO {
    screen: () => Promise<string>;
    /** A named key, as `cmux send-key` takes it: `ctrl+o`, `enter`. */
    key: (name: string) => Promise<void>;
    text: (text: string) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
}

export type FindOutcome =
    | { found: true; current: number; total: number }
    | { found: false; reason: "no-transcript" | "no-search-bar" | "no-match" | "no-result" };

function lastLine(screen: string): string {
    const lines = screen.split("\n").filter((line) => line.trim().length > 0);
    return lines.at(-1)?.trim() ?? "";
}

export function inTranscript(screen: string): boolean {
    return lastLine(screen).includes(TRANSCRIPT_BANNER) || /n\/N to navigate/.test(lastLine(screen));
}

/** The search bar is open: the bottom line is the typed `/query`. */
export function searchBarOpen(screen: string): boolean {
    return lastLine(screen).startsWith("/");
}

/** `{current, total}` from the bottom line, `"none"` for "no matches", null while there is no result. */
export function searchCount(screen: string): { current: number; total: number } | "none" | null {
    const line = lastLine(screen);

    if (/no matches\s*$/.test(line)) {
        return "none";
    }

    const match = line.match(/(\d+)\/(\d+)\s*$/);

    if (!match) {
        return null;
    }

    return { current: Number(match[1]), total: Number(match[2]) };
}

/** Presses of `n` from match `current` to match 1; `n` wraps from the last match to the first. */
export function pressesToOldest({ current, total }: { current: number; total: number }): number {
    return (total - current + 1) % total;
}

const STEP_MS = 150;

async function waitFor(io: TranscriptIO, test: (screen: string) => boolean, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
        const screen = await io.screen();

        if (test(screen)) {
            return screen;
        }

        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            return null;
        }

        await io.sleep(Math.min(STEP_MS, remaining));
    }
}

export async function findInTranscript(
    io: TranscriptIO,
    { query, oldest, timeoutMs = 3000 }: { query: string; oldest: boolean; timeoutMs?: number }
): Promise<FindOutcome> {
    const opened = !inTranscript(await io.screen());

    if (opened) {
        await io.key("ctrl+o");
    }

    if (!(await waitFor(io, inTranscript, timeoutMs))) {
        return { found: false, reason: "no-transcript" };
    }

    await io.text("/");

    if (!(await waitFor(io, searchBarOpen, timeoutMs))) {
        if (opened) {
            await io.key("ctrl+o");
        }

        return { found: false, reason: "no-search-bar" };
    }

    await io.text(query);
    await io.key("enter");
    const result = await waitFor(io, (screen) => !searchBarOpen(screen) && searchCount(screen) !== null, timeoutMs);
    const count = result ? searchCount(result) : null;

    if (count === null || count === "none") {
        // Back to the view the user had, so a miss leaves nothing behind.
        if (opened) {
            await io.key("ctrl+o");
        }

        return { found: false, reason: result ? "no-match" : "no-result" };
    }

    if (oldest) {
        for (let press = pressesToOldest(count); press > 0; press--) {
            await io.text("n");
        }

        const latest: { count: ReturnType<typeof searchCount> } = { count: null };
        await waitFor(
            io,
            (screen) => {
                latest.count = searchCount(screen);
                return latest.count !== null && latest.count !== "none" && latest.count.current === 1;
            },
            timeoutMs
        );

        const shown = latest.count;
        if (shown === null || shown === "none") {
            return { found: false, reason: "no-result" };
        }

        return { found: true, ...shown };
    }

    return { found: true, ...count };
}
