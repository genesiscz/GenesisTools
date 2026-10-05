/**
 * Shared HTML-to-Markdown conversion using Turndown with GFM support.
 */
import { gfm } from "@truto/turndown-plugin-gfm";
import TurndownService from "turndown";

/**
 * A Turndown service with the GFM plugin (tables, strikethrough, task lists) already applied.
 * Callers that need their own rules build on this instead of wiring the plugin again.
 */
export function createTurndownService(options?: TurndownService.Options): TurndownService {
    const service = new TurndownService(options);
    service.use(gfm);
    return service;
}

const turndown = createTurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
});

/**
 * Convert HTML content to clean Markdown.
 * Returns empty string for falsy input.
 */
export function htmlToMarkdown(html: string): string {
    if (!html) {
        return "";
    }
    return turndown.turndown(html).trim();
}
