/**
 * Shared HTML-to-Markdown conversion using Turndown with GFM support.
 */
import { gfm } from "@truto/turndown-plugin-gfm";
import TurndownService from "turndown";

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
