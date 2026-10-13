import { profiler } from "@genesiscz/utils/profile";
import type { CdpLike } from "./cdp-like.ts";
import { callInPage } from "./evaluate.ts";
import { type SpaNavigateResult, spaNavigate } from "./in-page/spa-navigate.ts";
import { type PageCondition, type WaitForResult, waitForCondition } from "./in-page/wait-for.ts";

const prof = profiler.scope("chrome-devtools");

export type { PageCondition, WaitForResult } from "./in-page/wait-for.ts";

export interface NavigateSpaOptions {
    path: string;
    replace?: boolean;
    /** Wait until this holds after the route change (for example the new page's heading). */
    waitFor?: PageCondition;
    /** Deadline for `waitFor`. Default 15 s. */
    timeoutMs?: number;
}

export interface NavigateSpaResult extends SpaNavigateResult {
    /** Present when `waitFor` was given. */
    settled?: WaitForResult;
}

/** The page was replaced while a call ran in it (a redirect, a login hop): the call can run again in the new one. */
const DOCUMENT_REPLACED = /navigated or closed|Execution context was destroyed|Cannot find context with specified id/i;

export function isDocumentReplaced(err: unknown): boolean {
    return DOCUMENT_REPLACED.test(err instanceof Error ? err.message : String(err));
}

/**
 * Waits in the page until a condition holds (DOM mutations plus a 250 ms layout re-check), or the deadline.
 * A redirect replaces the document and kills the in-page wait, so the wait starts again in each new document
 * until the deadline; `ms` always counts from the first call.
 */
export async function waitForPage(cdp: CdpLike, condition: PageCondition, timeoutMs = 15_000): Promise<WaitForResult> {
    const stopProfile = prof.start("spa.wait");
    try {
        const started = performance.now();
        for (;;) {
            const remaining = timeoutMs - (performance.now() - started);
            if (remaining <= 0) {
                return { ok: false, ms: performance.now() - started };
            }

            try {
                const result = await callInPage(
                    cdp,
                    waitForCondition,
                    { condition, timeoutMs: remaining },
                    { timeoutMs: remaining + 5_000 }
                );
                return { ok: result.ok, ms: performance.now() - started };
            } catch (err) {
                if (!isDocumentReplaced(err)) {
                    throw err;
                }

                // The next document may not exist yet; give it a moment before calling into it again.
                const pause = Math.min(250, Math.max(0, timeoutMs - (performance.now() - started)));
                await new Promise((resolve) => setTimeout(resolve, pause));
            }
        }
    } finally {
        stopProfile();
    }
}

/** In-app navigation without a reload (pushState + popstate), optionally waiting for the new page to show. */
export async function navigateSpa(cdp: CdpLike, options: NavigateSpaOptions): Promise<NavigateSpaResult> {
    const stopProfile = prof.start("spa.navigate");
    try {
        const moved = await callInPage(cdp, spaNavigate, { path: options.path, replace: options.replace });
        if (!options.waitFor) {
            return moved;
        }

        return { ...moved, settled: await waitForPage(cdp, options.waitFor, options.timeoutMs) };
    } finally {
        stopProfile();
    }
}
