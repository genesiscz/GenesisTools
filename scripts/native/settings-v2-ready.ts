/**
 * When a headless Settings page may be read: the part of `settings-v2.ts` that decides it, apart so a test can drive it
 * with scripted reads. The script itself runs on import (it parses argv and walks the app), so it cannot be imported.
 */

export interface AxRow {
    role: string;
    id: string;
    title: string;
    value: string;
    enabled: boolean;
}

export interface SwitchState {
    key: string;
    id: string;
    title: string;
    value: string;
}

/**
 * One read of the page. `drawn` tells a page that has no switches from one that was never read: an AX failure (no
 * Accessibility grant, a dead process) is an `error`, and a page whose window never appeared is not drawn.
 */
export interface PageRead {
    switches: SwitchState[];
    drawn: boolean;
    /** The page itself says its data has not arrived: a progress indicator, a "Loading…" label or a read failure notice. */
    pending: boolean;
    /** What is drawn and what the switches hold; two reads with the same outline mean the page stopped moving. */
    outline: string;
    error?: string;
}

const PENDING_TEXT = /^\s*loading\b|could not be read/i;

function isPending(row: AxRow): boolean {
    return row.role === "AXProgressIndicator" || PENDING_TEXT.test(row.title) || PENDING_TEXT.test(row.value);
}

/**
 * The page as the rows of one accessibility walk show it. The outline holds every row's role, identifier and title and
 * the value and enabled state of each switch (both decide `switches`), not the values of other rows: a label that
 * counts something changes on its own and would keep a loaded page from ever settling.
 */
export function readPage(rows: AxRow[], skip: ReadonlySet<string>): PageRead {
    const switches = rows
        .filter((row) => row.role === "AXCheckBox" && row.enabled && (row.id || row.title))
        .map((row) => ({ key: row.id || row.title, id: row.id, title: row.title, value: row.value }))
        .filter((row) => !skip.has(row.key));
    const outline = rows
        .map((row) =>
            row.role === "AXCheckBox"
                ? [row.role, row.id, row.title, row.value, String(row.enabled)]
                : [row.role, row.id, row.title]
        )
        .map((fields) => fields.join("\u0001"))
        .join("\n");
    return {
        switches,
        drawn: rows.some((row) => row.role === "AXWindow"),
        pending: rows.some(isPending),
        outline,
    };
}

export interface ReadyResult {
    /** The last read, which is the page to use when `ready`. */
    page: PageRead;
    ready: boolean;
    /** Why the page was not ready when the time ran out. */
    failure?: string;
}

function whyNotReady(page: PageRead): string {
    if (page.error) {
        return page.error;
    }

    if (!page.drawn) {
        return "the page never drew a window";
    }

    if (page.pending) {
        return "the page still showed that its data had not arrived";
    }

    return "the page kept changing and never settled";
}

/**
 * Reads until the page is ready or `timeoutMs` has passed. Ready is three reads in a row that are drawn, show no sign
 * of loading and have the same outline: the stored values arrive a moment after the window draws, so a page that has
 * not settled is not read yet. A page with no switches is ready the same way, once it is drawn and has stopped moving;
 * one that is still loading is not, however still it looks. On expiry the result is not ready and says why.
 */
export async function waitUntilReady({
    read,
    sleep,
    now,
    timeoutMs,
    intervalMs = 700,
    agreeingReads = 3,
}: {
    read: () => PageRead;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    timeoutMs: number;
    intervalMs?: number;
    agreeingReads?: number;
}): Promise<ReadyResult> {
    const deadline = now() + timeoutMs;
    let last: PageRead = { switches: [], drawn: false, pending: false, outline: "" };
    let agreeing = 0;

    while (now() < deadline) {
        await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
        const current = read();

        // A read can outlast the deadline (the AX read has its own, longer timeout): a late answer is not readiness.
        if (now() > deadline) {
            return { page: current, ready: false, failure: "a read of the page finished only after the deadline" };
        }

        const settled = current.drawn && !current.pending && !current.error;

        if (!settled) {
            agreeing = 0;
        } else if (agreeing > 0 && current.outline === last.outline) {
            agreeing++;
        } else {
            agreeing = 1;
        }

        last = current;

        if (agreeing >= agreeingReads) {
            return { page: last, ready: true };
        }
    }

    return { page: last, ready: false, failure: whyNotReady(last) };
}
