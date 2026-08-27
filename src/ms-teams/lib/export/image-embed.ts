/** Chat-sized cap: intrinsic width up to this, never the full thread column. */
export const EXPORT_IMAGE_MAX_WIDTH = "480px";

export const EXPORT_IMAGE_STYLE = `max-width: min(100%, ${EXPORT_IMAGE_MAX_WIDTH}); height: auto;`;

export function sizedMarkdownImage(src: string, alt: string): string {
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" style="${EXPORT_IMAGE_STYLE}" />`;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** A fence opens on three or more backticks or tildes, indented by at most three spaces. */
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Turn markdown image syntax into a capped HTML img so previews do not go full
 * width — outside code only.
 *
 * A single pass over the whole document also rewrote examples inside a fenced
 * block or inline code, so a message DOCUMENTING markdown had its example
 * silently converted to an <img> tag (PR #336 review t2). Splitting on
 * ```-or-single-backtick then still missed tilde fences, longer fences,
 * unclosed fences and multi-backtick spans (review t11), so code is now found
 * by an explicit scan rather than by one regex.
 */
export function sizeMarkdownImages(markdown: string): string {
    let fence: string | null = null;

    return markdown
        .split("\n")
        .map((line) => {
            if (fence) {
                if (closesFence(line, fence)) {
                    fence = null;
                }

                return line;
            }

            const opener = line.match(FENCE_RE)?.[1];

            if (opener) {
                fence = opener;
                return line;
            }

            return rewriteOutsideInlineCode(line);
        })
        .join("\n");
}

/** A closing fence repeats the opener's character at least as many times, and carries nothing else. */
function closesFence(line: string, fence: string): boolean {
    const run = line.match(FENCE_RE)?.[1];

    if (!run || run[0] !== fence[0] || run.length < fence.length) {
        return false;
    }

    return line.trimStart().slice(run.length).trim() === "";
}

function rewriteOutsideInlineCode(line: string): string {
    let out = "";
    let i = 0;

    while (i < line.length) {
        const tick = line.indexOf("`", i);

        if (tick === -1) {
            return out + rewriteImages(line.slice(i));
        }

        out += rewriteImages(line.slice(i, tick));

        let runEnd = tick;

        while (line[runEnd] === "`") {
            runEnd++;
        }

        const run = line.slice(tick, runEnd);
        const close = line.indexOf(run, runEnd);

        if (close === -1) {
            // A backtick run with no partner is literal text, not a code span.
            out += run;
            i = runEnd;
            continue;
        }

        out += line.slice(tick, close + run.length);
        i = close + run.length;
    }

    return out;
}

function rewriteImages(text: string): string {
    return text.replace(MARKDOWN_IMAGE_RE, (_m, alt: string, src: string) => sizedMarkdownImage(src, alt));
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
