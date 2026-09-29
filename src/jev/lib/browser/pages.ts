import { newTab } from "@app/chrome-devtools/lib/cdp";
import { DomPage } from "@app/chrome-devtools/lib/dom/page";
import { listTabs, tabTarget } from "@app/chrome-devtools/lib/tabs";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("jev-browser");

const MAX_LISTED_PAGES = 30;

export interface PageEntry {
    index: number;
    url: string;
    title?: string;
    selected?: boolean;
}

export interface PageSelector {
    pageUrl?: string;
    pageTitle?: string;
    pageIndex?: number;
    url?: string;
}

/**
 * The page a browser loop may act on. With no selector and more than one page open there is no
 * answer: acting on "whatever page was selected" is how a loop once clicked into a random one of
 * thirty tabs.
 */
export function matchPage<T extends PageEntry>(pages: T[], selector: PageSelector): T | undefined {
    if (selector.pageIndex !== undefined) {
        return pages.find((page) => page.index === selector.pageIndex);
    }

    if (selector.url) {
        const opened = pages.filter((page) => page.url === selector.url);
        return opened.length > 0 ? opened[opened.length - 1] : undefined;
    }

    if (selector.pageUrl) {
        const needle = selector.pageUrl.toLowerCase();
        return pages.find((page) => page.url.toLowerCase().includes(needle));
    }

    if (selector.pageTitle) {
        const needle = selector.pageTitle.toLowerCase();
        return pages.find((page) => (page.title ?? "").toLowerCase().includes(needle));
    }

    return pages.length === 1 ? pages[0] : undefined;
}

/** Why no page matched, with the list of what IS open. */
export function pageRefusal(pages: PageEntry[], selector: PageSelector): string {
    const listing = pages
        .slice(0, MAX_LISTED_PAGES)
        .map((page) => `  ${page.index}: ${page.url}${page.selected ? "  [selected]" : ""}`)
        .join("\n");
    const more = pages.length > MAX_LISTED_PAGES ? `\n  … ${pages.length - MAX_LISTED_PAGES} more` : "";
    if (selector.url) {
        return `The page for --url ${selector.url} is not in the page list. Pages:\n${listing}${more}`;
    }

    if (selector.pageUrl || selector.pageIndex !== undefined) {
        const flag = selector.pageUrl ? `--page-url ${selector.pageUrl}` : `--page-index ${selector.pageIndex}`;
        return `No CDP page matches ${flag}. Pages:\n${listing}${more}`;
    }

    return `${pages.length} CDP pages are open; pass --page-url <substring> or --page-index <n>. Pages:\n${listing}${more}`;
}

/**
 * Attaches to the page a goal names. Indexes follow the browser's target order (creation order),
 * which does not change when the user switches tabs; `/json/list` reorders by recent activity.
 */
export async function openGoalPage(options: { port: number; selector: PageSelector }): Promise<DomPage> {
    const { port, selector } = options;
    if (selector.url) {
        log.info({ url: selector.url }, "opening a new tab for the goal");
        return DomPage.attach({ port, target: await newTab(port, selector.url) });
    }

    const tabs = await listTabs(port);
    const pages = tabs.map((tab, index) => ({ index, url: tab.url, title: tab.title }));
    if (pages.length === 0) {
        throw new Error(`The browser on port ${port} lists no pages.`);
    }

    const chosen = matchPage(pages, selector);
    if (!chosen) {
        throw new Error(pageRefusal(pages, selector));
    }

    const target = await tabTarget(port, tabs[chosen.index].id);
    if (!target) {
        throw new Error(`The page ${chosen.url} closed while it was being selected.`);
    }

    log.info({ port, index: chosen.index, url: chosen.url, title: chosen.title }, "browser surface page selected");
    return DomPage.attach({ port, target });
}
