import { closeSync, openSync, readSync } from "node:fs";

/** How much of the file is held at once. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * The lines of a text file, read in chunks, so a large file is never held whole: a 218 MB transcript read
 * with `readFileSync(path, "utf8")` became a 640 MB string (UTF-16 once one character is not ASCII) before
 * a single line was looked at (2026-10-08). Lines are cut at newline bytes and decoded one by one, so a
 * multi-byte character is never split. The last line is yielded also without a trailing newline, as
 * `text.split("\n")` would give it; a file that ends with a newline yields a final empty line, the same way.
 * Throws when the file cannot be opened, like `readFileSync`.
 */
export function* readLinesSync(
    path: string,
    { chunkBytes = CHUNK_BYTES }: { chunkBytes?: number } = {}
): Generator<string> {
    const fd = openSync(path, "r");
    try {
        let carried = Buffer.alloc(0);
        let position = 0;
        const chunk = Buffer.allocUnsafe(chunkBytes);
        for (;;) {
            const read = readSync(fd, chunk, 0, chunk.length, position);
            if (read === 0) {
                break;
            }

            position += read;
            const bytes =
                carried.length > 0 ? Buffer.concat([carried, chunk.subarray(0, read)]) : chunk.subarray(0, read);
            let start = 0;
            let newline = bytes.indexOf(10, start);
            while (newline !== -1) {
                yield bytes.toString("utf8", start, newline);
                start = newline + 1;
                newline = bytes.indexOf(10, start);
            }

            // Copied: `chunk` is reused by the next read.
            carried = Buffer.from(bytes.subarray(start));
        }

        yield carried.toString("utf8");
    } finally {
        closeSync(fd);
    }
}
