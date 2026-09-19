import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { sameOrigin } from "./auth";
import type { BrowserMcp } from "./session";

const prof = profiler.scope("jev-browser");
const { log } = logger.scoped("jev-browser");

export const BROWSER_VERBS = [
    "click",
    "fill",
    "select",
    "scroll_down",
    "scroll_up",
    "back",
    "reload",
    "navigate",
    "wait",
] as const;
export type BrowserVerb = (typeof BROWSER_VERBS)[number];

/** Verbs that need no snapshot node; the surface offers them as chrome rows. */
export const CHROME_VERBS: BrowserVerb[] = ["back", "reload", "scroll_down", "scroll_up", "wait"];

export const VERB_DESCRIPTIONS: Record<BrowserVerb, string> = {
    click: "Activate the chosen page element.",
    fill: "Write a user-supplied value into the chosen field.",
    select: "Choose a user-supplied option in the chosen list.",
    scroll_down: "Scroll the page down by most of a viewport.",
    scroll_up: "Scroll the page up by most of a viewport.",
    back: "Go back one entry in the page history.",
    reload: "Reload the current page.",
    navigate: "Open a same-origin URL that the snapshot or the caller supplied.",
    wait: "Wait once for the page to settle, then observe again.",
};

const SCROLL_STEP =
    "() => { const before = window.scrollY; window.scrollBy(0, SIGN * window.innerHeight * 0.8); return `${before} -> ${window.scrollY}`; }";
const SETTLE_MS = 400;
const SETTLE = `async () => { await new Promise((resolve) => setTimeout(resolve, ${SETTLE_MS})); return document.readyState; }`;

export interface VerbRequest {
    verb: string;
    uid?: string;
    value?: string;
    url?: string;
    /** Current page URL; a `navigate` off this origin is refused. */
    pageUrl?: string;
}

export interface VerbResult {
    ok: boolean;
    error?: string;
    detail?: string;
}

function missing(verb: string, what: string): VerbResult {
    return { ok: false, error: `${verb} needs ${what}` };
}

/**
 * Runs one browser verb through chrome-devtools-mcp. Every verb here reaches a tool call or
 * answers `ok: false`; the earlier loop fell through to `ok: true` for scroll, wait and navigate,
 * so those three reported success without touching the browser.
 */
export async function performVerb(options: { mcp: BrowserMcp; request: VerbRequest }): Promise<VerbResult> {
    const { mcp, request } = options;
    const { verb, uid, value } = request;
    log.debug({ verb, uid, hasValue: value !== undefined, url: request.url }, "browser verb dispatch");
    const call = async (name: string, args: Record<string, unknown>): Promise<VerbResult> => {
        const result = await prof.measureAsync(verb, () => mcp.callTool(name, args));
        return { ok: true, detail: mcp.toolText(result).slice(0, 200) };
    };

    if (verb === "click") {
        return uid ? call("click", { uid }) : missing(verb, "a snapshot uid");
    }

    if (verb === "fill" || verb === "select") {
        if (!uid) {
            return missing(verb, "a snapshot uid");
        }

        return value === undefined ? missing(verb, "a value from --inputs") : call("fill", { uid, value });
    }

    if (verb === "back" || verb === "reload") {
        return call("navigate_page", { type: verb });
    }

    if (verb === "scroll_down" || verb === "scroll_up") {
        return call("evaluate_script", { function: SCROLL_STEP.replace("SIGN", verb === "scroll_up" ? "-1" : "1") });
    }

    if (verb === "wait") {
        return call("evaluate_script", { function: SETTLE });
    }

    if (verb === "navigate") {
        if (!request.url) {
            return missing(verb, "a URL from the snapshot or --url");
        }

        if (request.pageUrl && !sameOrigin(request.pageUrl, request.url)) {
            return { ok: false, error: `navigate refused: ${request.url} leaves the origin of ${request.pageUrl}` };
        }

        return call("navigate_page", { type: "url", url: request.url });
    }

    log.warn({ verb }, "browser verb is not in the verb table");
    return { ok: false, error: `unsupported_verb: ${verb}` };
}
