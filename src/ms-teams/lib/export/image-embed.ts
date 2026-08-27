/** Chat-sized cap: intrinsic width up to this, never the full thread column. */
export const EXPORT_IMAGE_MAX_WIDTH = "480px";

export const EXPORT_IMAGE_STYLE = `max-width: min(100%, ${EXPORT_IMAGE_MAX_WIDTH}); height: auto;`;

export function sizedMarkdownImage(src: string, alt: string): string {
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" style="${EXPORT_IMAGE_STYLE}" />`;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Split on fenced blocks and inline code, keeping the delimiters.
 *
 * A capturing group in the split pattern makes the delimiters part of the
 * result, so the odd-indexed chunks are exactly the spans to leave alone.
 */
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/;

/**
 * Turn markdown image syntax into a capped HTML img so previews do not go full
 * width — outside code only.
 *
 * A single pass over the whole document also rewrote examples inside a fenced
 * block or inline code, so a message DOCUMENTING markdown had its example
 * silently converted to an <img> tag (PR #336 review t2).
 */
export function sizeMarkdownImages(markdown: string): string {
    return markdown
        .split(CODE_SPAN_RE)
        .map((chunk, i) =>
            i % 2 === 1
                ? chunk
                : chunk.replace(MARKDOWN_IMAGE_RE, (_m, alt: string, src: string) => sizedMarkdownImage(src, alt))
        )
        .join("");
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
