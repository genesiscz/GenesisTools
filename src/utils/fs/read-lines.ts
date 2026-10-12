import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
    cPath,
    errnoError,
    errnoNow,
    type LibSystem,
    libSystem,
    O_CLOEXEC,
    O_RDONLY,
    SEEK_END,
} from "./native/libsystem";

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

/** How far `readFirstLines` and `readLastLines` read by default. */
const END_BYTES = 64 * 1024;

/** One buffer for every call: the reads are synchronous, so two calls never share it at once. */
let endBuffer = Buffer.allocUnsafe(END_BYTES + 1);

function bufferOf(bytes: number): Buffer {
    if (endBuffer.length < bytes) {
        endBuffer = Buffer.allocUnsafe(bytes);
    }

    return endBuffer;
}

/** The non-empty lines between two byte offsets, each decoded on its own, a trailing `\r` removed. */
function linesBetween(buffer: Buffer, start: number, end: number): string[] {
    const lines: string[] = [];
    let from = start;

    while (from < end) {
        const newline = buffer.indexOf(10, from);
        const to = newline === -1 || newline >= end ? end : newline;
        const line = buffer.toString("utf8", from, buffer[to - 1] === 13 ? to - 1 : to);

        if (line.trim() !== "") {
            lines.push(line);
        }

        from = to + 1;
    }

    return lines;
}

/** The four calls a range read needs. */
interface RangeReader {
    open(path: string): number;
    size(fd: number): number;
    read(fd: number, buffer: Buffer, length: number, position: number): number;
    close(fd: number): void;
}

const fsReader: RangeReader = {
    open: (path) => openSync(path, "r"),
    size: (fd) => fstatSync(fd).size,
    read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
    close: (fd) => closeSync(fd),
};

function ffiReader(calls: LibSystem): RangeReader {
    return {
        open: (path) => {
            const fd = calls.open(cPath(path), O_RDONLY | O_CLOEXEC);

            if (fd < 0) {
                throw errnoError(errnoNow(calls), "open", path);
            }

            return fd;
        },
        size: (fd) => {
            const size = Number(calls.lseek(fd, 0, SEEK_END));

            if (size < 0) {
                throw errnoError(errnoNow(calls), "lseek", `fd ${fd}`);
            }

            return size;
        },
        read: (fd, buffer, length, position) => {
            const read = Number(calls.pread(fd, buffer, length, position));

            if (read < 0) {
                throw errnoError(errnoNow(calls), "pread", `fd ${fd}`);
            }

            return read;
        },
        close: (fd) => {
            calls.close(fd);
        },
    };
}

function readerFor(method: EdgeReadOptions["method"]): RangeReader {
    const calls = method === "ffi" ? libSystem() : null;
    return calls ? ffiReader(calls) : fsReader;
}

export interface EdgeReadOptions {
    /** How far to read; 64 KB by default. */
    maxBytes?: number;
    /**
     * `fs` (default): `node:fs` synchronous calls. `ffi`: `open`, `lseek` and `pread` from macOS `libSystem`
     * through `bun:ffi`, the same system calls without Node's wrappers; `fs` is used where `libSystem` is not
     * there. Both measured the same CPU (`scripts/benchmarks/fs/read-primitives.ts`), so `fs` stays the default.
     */
    method?: "fs" | "ffi";
}

export interface EdgeLines {
    /** The non-empty lines read, in file order. A line cut by the edge of the read is left out. */
    lines: string[];
    /** True when the read covered the whole file, so nothing was left out at the far end. */
    wholeFile: boolean;
}

/**
 * The first lines of a file, from one synchronous read of at most `maxBytes` (64 KB by default): for a header, a
 * title, or anything else at the top of a large file. A line longer than `maxBytes` gives no lines; read more, or
 * read the file in full. Measured on 623 Codex rollouts (`scripts/benchmarks/fs/read-primitives.ts`, 2026-10-12):
 * 23 ms of CPU, against 39 ms for `Bun.file().slice().text()`, 62 ms for `fs/promises`, 90 ms for a stream's first
 * chunk and 385 ms for whole files; pure FFI was no faster. Throws when the file cannot be opened.
 */
export function readFirstLines(path: string, { maxBytes = END_BYTES, method }: EdgeReadOptions = {}): EdgeLines {
    const reader = readerFor(method);
    const fd = reader.open(path);

    try {
        // One byte more than asked tells whether the file ends inside the read.
        const buffer = bufferOf(maxBytes + 1);
        const read = reader.read(fd, buffer, maxBytes + 1, 0);
        const wholeFile = read <= maxBytes;
        const end = wholeFile ? read : buffer.lastIndexOf(10, maxBytes - 1) + 1;
        return { lines: linesBetween(buffer, 0, end), wholeFile };
    } finally {
        reader.close(fd);
    }
}

/**
 * The last lines of a file, from one synchronous read of at most `maxBytes` (64 KB by default): for the newest
 * records of a log or transcript that only grows at the end. The last line is kept even when it has no newline yet
 * (a writer may be in the middle of it). Measured on 627 Claude transcripts: 25 ms of CPU, against 43 ms for one
 * `Bun.file().slice()` and 61 ms for the two slices the old `readTailBytes` made. Throws when the file cannot be opened.
 */
export function readLastLines(path: string, { maxBytes = END_BYTES, method }: EdgeReadOptions = {}): EdgeLines {
    const reader = readerFor(method);
    const fd = reader.open(path);

    try {
        const size = reader.size(fd);
        // The byte before the window tells whether the window starts on a line.
        const start = Math.max(0, size - maxBytes - 1);
        const buffer = bufferOf(size - start);
        const read = reader.read(fd, buffer, size - start, start);
        let from = 0;

        if (start > 0) {
            const newline = buffer.indexOf(10);

            if (newline === -1 || newline >= read) {
                return { lines: [], wholeFile: false };
            }

            from = newline + 1;
        }

        return { lines: linesBetween(buffer, from, read), wholeFile: start === 0 };
    } finally {
        reader.close(fd);
    }
}
