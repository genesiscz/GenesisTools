import type { Logger } from "@genesiscz/utils/logger";

/** How a param value is checked and what the resolver gets back for it. */
export type TransclusionParamType = "string" | "int" | "range" | "path" | "url" | "enum" | "bool";

export interface TransclusionParam {
    name: string;
    description: string;
    type: TransclusionParamType;
    required?: boolean;
    /** The allowed values of an `enum` param. */
    values?: readonly string[];
    /** Used when the token leaves the param out. Shown in the help. */
    default?: string | number | boolean;
}

/** A line range: `10-40`, `10` (one line), `10-` (to the end), `-40` (from the start). */
export interface LineRange {
    start: number;
    /** null means "to the end of the file". */
    end: number | null;
}

export type TransclusionParamValue = string | number | boolean | LineRange;

/** What a resolver returns. `meta` is recorded on the token, never printed into the text. */
export interface TransclusionResult {
    markdown: string;
    meta?: Record<string, unknown>;
    /** A block (code fence, quote) is placed on lines of its own when the token sits inside a sentence. */
    block?: boolean;
    /**
     * The exact identity of what was read, for the provenance footer and meta:
     * `src/a.ts@545308d99 (uncommitted changes)`, `$ git log -3 (exit 0)`, `https://… (HTTP 200)`.
     */
    source?: string;
    /** Set when the resolver showed less than it read: the footer says "showing 40 of 212 lines". */
    shown?: { shown: number; total: number; unit: string };
}

export interface CommandOutput {
    code: number;
    stdout: string;
    stderr: string;
    /** Set when a stream passed the runner's byte cap: the output is cut there and the child was stopped. */
    truncated?: boolean;
}

/** Runs an argv (never a shell) and returns its output. A spawn failure is a result with code 127. */
export type TransclusionRunner = (
    argv: string[],
    options: { cwd: string; signal: AbortSignal; timeoutMs?: number; env?: Record<string, string> }
) => Promise<CommandOutput>;

export interface TransclusionContext {
    /** Relative paths resolve against it. */
    cwd: string;
    logger: Logger;
    /** Aborts at the per-token deadline or when the caller cancels. Every resolver must honour it. */
    signal: AbortSignal;
    /** The deadline of this token, in ms since the epoch. */
    deadline: number;
    /** The most characters one substitution may produce before it is cut with a marker. */
    maxChars: number;
    /** Masks secrets in a text. The engine also runs it over every substitution. */
    redact: (text: string) => string;
    run: TransclusionRunner;
    fetch: typeof fetch;
    /** Where a kind that copies files (image) stores them. Unset means those kinds fail with a reason. */
    assetDir?: string;
    /** A read-only preview: a kind that would copy a file embeds the original path and writes nothing. */
    preview?: boolean;
}

/**
 * `substitute` freezes the content at save time: right for a file, lines or a diff pinned to a commit.
 * `verify` also stores the snapshot, but keeps the token live: `recheck()` resolves it again later
 * and reports whether the answer changed since capture. Right for answers that flip within hours
 * (a PR thread, a web page, CI status, a port).
 */
export type TransclusionAction = "substitute" | "verify";

export interface TransclusionDefinition {
    name: string;
    description: string;
    params: TransclusionParam[];
    /** Complete tokens, the first is the one the help prints. */
    examples: string[];
    /** Defaults to `substitute`. */
    action?: TransclusionAction;
    /** Each group needs exactly one of its params, e.g. `[["range", "anchor"]]`. */
    requireOneOf?: string[][];
    resolve: (params: TransclusionParams, ctx: TransclusionContext) => Promise<TransclusionResult>;
}

/**
 * The validated params of one token. The getters throw a plain error when a resolver asks for a
 * name its own definition does not declare, which is a bug in the definition, not in the token.
 */
export interface TransclusionParams {
    has(name: string): boolean;
    string(name: string): string;
    optionalString(name: string): string | undefined;
    int(name: string): number;
    optionalInt(name: string): number | undefined;
    bool(name: string): boolean;
    range(name: string): LineRange;
    optionalRange(name: string): LineRange | undefined;
    /** The raw validated values, as recorded on the token. */
    values(): Record<string, TransclusionParamValue>;
}

/** One token of a transcluded text, as logged and stored. */
export interface TransclusionToken {
    raw: string;
    kind: string;
    /** The definition's action; a `verify` token can be rechecked later. */
    action?: TransclusionAction;
    /** When the content was captured (ISO time). */
    capturedAt?: string;
    /** Where relative paths resolved, so a recheck reads the same files. */
    cwd?: string;
    /** sha256 of the resolved content (before the footer), compared by `recheck()`. */
    signature?: string;
    /** The resolved content of a `verify` token, so a recheck can say what it was. */
    snapshot?: string;
    /** `#include` when the token used the mdBook form. */
    alias?: string;
    /** The params as written (strings), after alias mapping. */
    params: Record<string, string>;
    ok: boolean;
    error?: string;
    meta?: Record<string, unknown>;
    /** Characters the substitution put into the text (the marker's length for a failure). */
    chars: number;
    ms: number;
    truncated?: boolean;
}

export interface TranscludeResult {
    text: string;
    tokens: TransclusionToken[];
}
