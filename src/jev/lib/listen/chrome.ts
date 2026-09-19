import { callTool, toolText } from "@app/chrome-devtools/lib/mcp";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { ChromeVerb } from "./verbs";

const prof = profiler.scope("jev-listen");
const { log } = logger.scoped("jev-listen-chrome");

export interface ChromePage {
    index: number;
    title: string;
    url: string;
    selected: boolean;
    raw: string;
}

/**
 * `list_pages` (chrome-devtools-mcp 1.6) prints `## Pages` and then one line per page:
 * `12: <title> (<url>) [selected]`; a page without a title prints `12: <url>`.
 */
export function parsePageList(text: string): ChromePage[] {
    const pages: ChromePage[] = [];
    for (const line of text.split(/\r?\n/)) {
        const titled =
            /^\s*(\d+):\s*(.*?)\s*\((https?:\/\/\S+|about:\S+|chrome:\/\/\S+|file:\/\/\S+)\)\s*(\[selected\])?\s*$/i.exec(
                line
            );
        if (titled) {
            pages.push({
                index: Number(titled[1]),
                title: titled[2],
                url: titled[3],
                selected: titled[4] !== undefined,
                raw: line.trim(),
            });
            continue;
        }

        const bare = /^\s*(\d+):\s*(\S+)\s*(\[selected\])?\s*$/i.exec(line);
        if (bare) {
            pages.push({
                index: Number(bare[1]),
                title: "",
                url: bare[2],
                selected: bare[3] !== undefined,
                raw: line.trim(),
            });
        }
    }

    return pages;
}

/**
 * Dispatches one chrome verb through chrome-devtools-mcp. `ok: true` is returned only after the
 * MCP call returned; before this existed the listen surface answered `ok: true` for every chrome
 * verb without dispatching anything.
 */
export async function dispatchChromeVerb(options: {
    verb: ChromeVerb;
    port: number;
}): Promise<{ ok: boolean; error?: string; detail?: string }> {
    const stop = prof.start(`chrome-${options.verb}`);
    log.info({ verb: options.verb, port: options.port }, "dispatching chrome verb through chrome-devtools-mcp");
    try {
        if (options.verb === "back" || options.verb === "reload") {
            const result = await callTool("navigate_page", { type: options.verb }, { port: options.port });
            return { ok: true, detail: toolText(result).slice(0, 200) };
        }

        const listed = await callTool("list_pages", {}, { port: options.port });
        const pages = parsePageList(toolText(listed));
        const selected = pages.findIndex((page) => page.selected);
        if (pages.length === 0 || selected < 0) {
            log.warn({ text: toolText(listed).slice(0, 300) }, "list_pages returned no parsable selected page");
            return { ok: false, error: "chrome-devtools listed no selected page" };
        }

        if (options.verb === "close_tab") {
            await callTool("close_page", { pageId: pages[selected].index }, { port: options.port });
            return { ok: true, detail: `closed page ${pages[selected].index}` };
        }

        const step = options.verb === "next_tab" ? 1 : -1;
        const target = pages[(selected + step + pages.length) % pages.length];
        await callTool("select_page", { pageId: target.index }, { port: options.port });
        return { ok: true, detail: `selected page ${target.index} ${target.url}` };
    } catch (error) {
        log.warn({ error, verb: options.verb }, "chrome verb dispatch failed");
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        stop();
    }
}
