import { DomPage } from "@app/chrome-devtools/lib/dom/page";
import { activateTab, closeTab, currentTab, listTabs, tabTarget } from "@app/chrome-devtools/lib/tabs";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { ChromeVerb } from "./verbs";

const prof = profiler.scope("jev-listen");
const { log } = logger.scoped("jev-listen-chrome");

/**
 * Dispatches one chrome verb over our own CDP client. `pageTitle` names the tab the user means (the
 * frontmost browser window's title); without it the most recently active tab is used. `ok: true`
 * is returned only after the browser answered.
 */
export async function dispatchChromeVerb(options: {
    verb: ChromeVerb;
    port: number;
    pageTitle?: string;
}): Promise<{ ok: boolean; error?: string; detail?: string }> {
    const stop = prof.start(`chrome-${options.verb}`);
    try {
        const tab = await currentTab({ port: options.port, title: options.pageTitle });
        log.info({ verb: options.verb, port: options.port, tab: tab.url }, "dispatching chrome verb over CDP");
        if (options.verb === "back" || options.verb === "reload") {
            const target = await tabTarget(options.port, tab.id);
            if (!target) {
                return { ok: false, error: `the tab ${tab.url} closed before ${options.verb}` };
            }

            const page = await DomPage.attach({ port: options.port, target });
            try {
                const result = options.verb === "back" ? await page.back() : await page.reload();
                return result.ok
                    ? { ok: true, detail: `${options.verb} on ${tab.url}` }
                    : { ok: false, error: result.error };
            } finally {
                page.close();
            }
        }

        if (options.verb === "close_tab") {
            await closeTab(options.port, tab.id);
            return { ok: true, detail: `closed ${tab.url}` };
        }

        const tabs = await listTabs(options.port);
        const index = tabs.findIndex((item) => item.id === tab.id);
        if (index < 0 || tabs.length < 2) {
            return { ok: false, error: "there is no other tab to switch to" };
        }

        const step = options.verb === "next_tab" ? 1 : -1;
        const next = tabs[(index + step + tabs.length) % tabs.length];
        await activateTab(options.port, next.id);
        return { ok: true, detail: `activated ${next.url}` };
    } catch (error) {
        log.warn({ error, verb: options.verb }, "chrome verb dispatch failed");
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        stop();
    }
}
