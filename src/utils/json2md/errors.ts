/**
 * Typed errors.
 *
 * Every failure carries a machine-readable `code` and, where the failure is located in the
 * input, an RFC 6901 JSON Pointer. A caller can branch on the code; a bare `Error` with a
 * sentence in it forces callers to match on message text, which breaks on the next reword.
 */

export type Json2mdErrorCode =
    /** A block object carried a key with no registered converter. */
    | "UNKNOWN_BLOCK"
    /** A block object carried more than one key, so its type is ambiguous. */
    | "MULTI_KEY_BLOCK"
    /** A table was declared with an empty column list. */
    | "NO_COLUMNS"
    /** `pickColumns` was asked for a column that does not exist. */
    | "UNKNOWN_COLUMN"
    /** `unknownKey: "throw"` and a row carried a key no column covers. */
    | "UNCOVERED_KEYS"
    /** The value nests deeper than `maxDepth`. */
    | "MAX_DEPTH_EXCEEDED"
    /** The value contains a cycle, so rendering it would never terminate. */
    | "CYCLIC_REFERENCE"
    /** An option was outside its allowed set. */
    | "INVALID_OPTION"
    /** A selection expression did not parse. */
    | "SELECT_FAILED"
    /** A document module had no `defineDocument` default export. */
    | "NO_DOCUMENT_EXPORT"
    /** A document's data file is missing. */
    | "DATA_NOT_FOUND";

export interface Json2mdErrorOptions {
    /** RFC 6901 pointer to the offending value, for example `/items/3/name`. */
    pointer?: string;
    cause?: unknown;
}

export class Json2mdError extends Error {
    readonly code: Json2mdErrorCode;
    readonly pointer: string | undefined;

    constructor(code: Json2mdErrorCode, message: string, options: Json2mdErrorOptions = {}) {
        super(options.pointer ? `${message} (at ${options.pointer})` : message, { cause: options.cause });
        this.name = "Json2mdError";
        this.code = code;
        this.pointer = options.pointer;
    }
}

/** Builds an RFC 6901 pointer from path segments, escaping `~` and `/` as the spec requires. */
export function pointerOf(segments: ReadonlyArray<string | number>): string {
    if (segments.length === 0) {
        return "";
    }

    return `/${segments.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
