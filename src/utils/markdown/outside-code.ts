/** A fence opens on three or more backticks or tildes, indented by at most three spaces. */
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Applies `transform` to the prose of a markdown text and leaves code as written: fenced blocks (backtick or tilde,
 * any length, closed by a fence at least as long or by the end of the text) and inline code spans of any backtick
 * count. Prose reaches `transform` one line at a time, minus its inline code, and never empty.
 *
 * Code is found by an explicit scan rather than one regex, because a pattern that splits on ``` or a single
 * backtick misses tilde fences, longer fences, unclosed fences and multi-backtick spans.
 */
export function mapOutsideCode(markdown: string, transform: (prose: string) => string): string {
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

            return mapOutsideInlineCode(line, transform);
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

function mapOutsideInlineCode(line: string, transform: (prose: string) => string): string {
    const prose = (text: string): string => (text ? transform(text) : text);
    let out = "";
    let i = 0;

    while (i < line.length) {
        const tick = line.indexOf("`", i);

        if (tick === -1) {
            return out + prose(line.slice(i));
        }

        out += prose(line.slice(i, tick));

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
