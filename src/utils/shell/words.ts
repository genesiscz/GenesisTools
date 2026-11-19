/** One top-level word of a POSIX shell line: where it sits in the line, and its value once quotes are removed. */
export interface ShellWordSpan {
    start: number;
    /** Offset just past the word's last character. */
    end: number;
    value: string;
}

/**
 * The words of a shell line split at unquoted blanks, with their spans, so a caller can drop or replace one word and
 * keep every other byte of the line as it was. Single quotes, double quotes (with `\` before `"`, `\`, `$` and a
 * backtick) and a backslash outside quotes are read as `sh` reads them, so `'it'\''s'` is one word with the value
 * `it's`. Operators (`;`, `|`, `&&`) are not split off: such a word only ever matches a pattern that names them.
 */
export function shellWordSpans(line: string): ShellWordSpan[] {
    const spans: ShellWordSpan[] = [];
    let start = -1;
    let value = "";
    let i = 0;

    const close = (end: number) => {
        if (start >= 0) {
            spans.push({ start, end, value });
            start = -1;
            value = "";
        }
    };

    while (i < line.length) {
        const ch = line[i];

        if (/\s/.test(ch)) {
            close(i);
            i++;
            continue;
        }

        if (start < 0) {
            start = i;
        }

        if (ch === "'") {
            const endQuote = line.indexOf("'", i + 1);
            const stop = endQuote < 0 ? line.length : endQuote;
            value += line.slice(i + 1, stop);
            i = stop + 1;
            continue;
        }

        if (ch === '"') {
            i++;

            while (i < line.length && line[i] !== '"') {
                if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
                    value += line[i + 1];
                    i += 2;
                    continue;
                }

                value += line[i];
                i++;
            }

            i++;
            continue;
        }

        if (ch === "\\" && i + 1 < line.length) {
            value += line[i + 1];
            i += 2;
            continue;
        }

        value += ch;
        i++;
    }

    close(Math.min(i, line.length));
    return spans;
}
