/** Chat-sized cap: intrinsic width up to this, never the full thread column. */
export const EXPORT_IMAGE_MAX_WIDTH = "480px";

export const EXPORT_IMAGE_STYLE = `max-width: min(100%, ${EXPORT_IMAGE_MAX_WIDTH}); height: auto;`;

export function sizedMarkdownImage(src: string, alt: string): string {
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" style="${EXPORT_IMAGE_STYLE}" />`;
}

/** Turn markdown image syntax into a capped HTML img so previews do not go full width. */
export function sizeMarkdownImages(markdown: string): string {
    return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt: string, src: string) =>
        sizedMarkdownImage(src, alt)
    );
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
