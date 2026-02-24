/**
 * Shared HTML-to-Markdown conversion using Turndown with GFM support.
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
});
turndown.use(gfm);

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
