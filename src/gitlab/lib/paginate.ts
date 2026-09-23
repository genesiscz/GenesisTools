/**
 * GitLab offset pagination that neither stops early nor loops.
 *
 * With `X-Next-Page`: follow it. GitLab filters some endpoints by visibility AFTER it builds a page
 * (`/users/:id/events` does), so a page can hold 99 of 100 items while more pages exist; a short
 * page is not the end there, the header is.
 *
 * Without the header the endpoint is not offset-paginated: a short page is the last one, and a page
 * that repeats the previous one means `page` is ignored, so the walk ends and the repeat is dropped.
 * `merge_requests/:iid/draft_notes` is such an endpoint: it returned the same drafts for every page
 * until the page cap before this rule.
 */

import { SafeJSON } from "@genesiscz/utils/json";

export interface Page<T> {
    items: T[];
    /** Parsed `X-Next-Page`: a page number, `null` when the header is present but empty, `undefined` when absent. */
    nextPage?: number | null;
}

export interface PageResult<T> {
    items: T[];
    pages: number;
    truncated: boolean;
}

export function parseNextPage(header: string | null): number | null | undefined {
    if (header === null) {
        return undefined;
    }

    const n = Number.parseInt(header, 10);

    return Number.isInteger(n) && n > 0 ? n : null;
}

export async function fetchAllPages<T>(
    getPage: (page: number) => Promise<Page<T>>,
    opts: { maxPages: number; perPage?: number }
): Promise<PageResult<T>> {
    const items: T[] = [];
    let page = 1;
    let fetched = 0;
    let previous: string | undefined;

    while (fetched < opts.maxPages) {
        const { items: batch, nextPage } = await getPage(page);
        fetched++;

        if (nextPage === undefined) {
            const signature = SafeJSON.stringify(batch);

            if (batch.length === 0 || signature === previous) {
                return { items, pages: fetched, truncated: false };
            }

            items.push(...batch);

            if (opts.perPage !== undefined && batch.length < opts.perPage) {
                return { items, pages: fetched, truncated: false };
            }

            previous = signature;
            page++;
            continue;
        }

        items.push(...batch);

        if (nextPage === null) {
            return { items, pages: fetched, truncated: false };
        }

        page = nextPage;
    }

    return { items, pages: fetched, truncated: true };
}
