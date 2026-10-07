import { logger } from "@genesiscz/utils/logger";
import { browser, type Target, targets } from "./cdp";

const { log } = logger.scoped("chrome-devtools-tabs");

export interface TabInfo {
    id: string;
    url: string;
    title: string;
}

/**
 * Page tabs in the browser's target order (creation order, the same order chrome-devtools-mcp's
 * `list_pages` used). CDP has no tab-strip order, so "next tab" means the next target.
 */
export async function listTabs(port: number): Promise<TabInfo[]> {
    const connection = await browser(port);
    try {
        const { targetInfos } = (await connection.send("Target.getTargets")) as {
            targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
        };
        return targetInfos
            .filter((info) => info.type === "page")
            .map((info) => ({ id: info.targetId, url: info.url, title: info.title }));
    } finally {
        connection.close();
    }
}

async function onBrowser(port: number, method: string, params: Record<string, unknown>): Promise<void> {
    const connection = await browser(port);
    try {
        await connection.send(method, params);
    } finally {
        connection.close();
    }
}

export function activateTab(port: number, id: string): Promise<void> {
    return onBrowser(port, "Target.activateTarget", { targetId: id });
}

export function closeTab(port: number, id: string): Promise<void> {
    return onBrowser(port, "Target.closeTarget", { targetId: id });
}

/**
 * The tab a command like "go back" or "close this tab" means. CDP has no "active tab" call, so a
 * caller names it by title (a browser window's title is its active tab's title). Without a title,
 * or when the title matches no tab, the most recently active page wins: `/json/list` sorts pages by
 * last activity, newest first.
 */
export async function currentTab(options: { port: number; title?: string }): Promise<TabInfo> {
    const recent = (await targets(options.port)).filter((target) => target.type === "page");
    if (recent.length === 0) {
        throw new Error(`The browser on port ${options.port} lists no pages.`);
    }

    const title = options.title?.trim().toLowerCase();
    if (title) {
        const exact = recent.filter((target) => target.title.trim().toLowerCase() === title);
        const partial = recent.filter((target) => target.title.toLowerCase().includes(title));
        const hit = exact[0] ?? partial[0];
        if (hit) {
            log.debug(
                { title: options.title, id: hit.id, matches: exact.length || partial.length },
                "current tab by title"
            );
            return toTab(hit);
        }

        log.info({ title: options.title }, "no tab carries the window title; using the most recently active page");
    }

    return toTab(recent[0]);
}

function toTab(target: Target): TabInfo {
    return { id: target.id, url: target.url, title: target.title };
}

/** The page target for a tab, with its debugger socket, or undefined when the tab is gone. */
export async function tabTarget(
    port: number,
    id: string,
    options: { signal?: AbortSignal } = {}
): Promise<Target | undefined> {
    return (await targets(port, options)).find((target) => target.id === id);
}
