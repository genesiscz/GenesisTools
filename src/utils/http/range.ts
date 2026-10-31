/** One `Range: bytes=…` header read against a body of `size` bytes. */
export type ByteRange =
    /** The header is missing or is not a single `bytes=a-b` range: serve the whole body. */
    | { kind: "none" }
    /** A well-formed range that starts past the end or ends before it starts: answer 416. */
    | { kind: "unsatisfiable" }
    | { kind: "range"; start: number; end: number };

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/** Parses a single byte range; `bytes=-500` is the last 500 bytes, `bytes=100-` runs to the end. */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange {
    const match = header ? RANGE_RE.exec(header.trim()) : null;

    if (!match || (match[1] === "" && match[2] === "")) {
        return { kind: "none" };
    }

    const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
        return { kind: "unsatisfiable" };
    }

    return { kind: "range", start, end };
}
