import { createHash } from "node:crypto";
import { type Logger, logger as rootLogger } from "@genesiscz/utils/logger";
import { parseTranscludeText, type Segment, type TokenSegment } from "./parse";
import { redactSecretsInText } from "./redact";
import {
    TransclusionError,
    type TransclusionRegistry,
    unknownKindMessage,
    validateTransclusionParams,
} from "./registry";
import { defaultRunner } from "./runner";
import type {
    TranscludeResult,
    TransclusionAction,
    TransclusionContext,
    TransclusionResult,
    TransclusionRunner,
    TransclusionToken,
} from "./types";

export const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TOKEN_CHARS = 8_000;
export const DEFAULT_MAX_TEXT_CHARS = 40_000;
const CONCURRENCY = 4;

export interface TranscludeOptions {
    registry: TransclusionRegistry;
    cwd: string;
    logger?: Logger;
    /** Cancels every token still resolving. */
    signal?: AbortSignal;
    /** Deadline per token. */
    timeoutMs?: number;
    maxTokenChars?: number;
    /** The most characters all substitutions of one text may add; later tokens fail with a reason. */
    maxTextChars?: number;
    redact?: (text: string) => string;
    run?: TransclusionRunner;
    fetch?: typeof fetch;
    assetDir?: string;
    /** A read-only preview: kinds that copy files (image) say what they would store and write nothing. */
    preview?: boolean;
    /** A label for the log lines, e.g. `item 2 reasoning`. */
    label?: string;
    /**
     * True when the caller prints the failures and the summary itself (the question CLI does, one clean
     * stderr line each). They are then logged at debug, which still reaches the day log file but not
     * the console, so the user does not read every failure twice.
     */
    callerReports?: boolean;
    /**
     * `mark` (default) replaces a failed token with a visible marker. `throw` resolves every token, then
     * throws a {@link TranscludeFailedError} naming each failure: an externally visible sink (a PR
     * comment) must fail closed and refuse to post rather than publish a marker.
     */
    onFailure?: "mark" | "throw";
    /** The capture clock; tests pin it. */
    now?: () => Date;
}

/** Thrown by `transclude(…, { onFailure: "throw" })` after every token was tried. */
export class TranscludeFailedError extends Error {
    constructor(readonly failed: TransclusionToken[]) {
        super(
            `${failed.length} token(s) did not resolve: ${failed.map((token) => `${token.raw}: ${token.error}`).join("; ")}`
        );
    }
}

interface Resolved {
    segment: TokenSegment;
    action?: TransclusionAction;
    result?: TransclusionResult;
    error?: string;
    params: Record<string, string>;
    values?: Record<string, unknown>;
    ms: number;
}

/**
 * Resolves every token of a text. Each substitution is logged (debug), each failure is logged
 * (warn) and replaced by a visible `⚠️ unresolved` marker that keeps the raw token and the reason,
 * and one summary line is logged per call (info). Never throws for a bad token.
 */
export async function transclude(text: string, options: TranscludeOptions): Promise<TranscludeResult> {
    const log = (options.logger ?? rootLogger.child({ component: "transclude" })).child({
        ...(options.label ? { field: options.label } : {}),
    });
    const segments = parseTranscludeText(text);
    const tokens = segments.filter((segment): segment is TokenSegment => segment.type === "token");

    if (tokens.length === 0) {
        return { text: joinLiterals(segments), tokens: [] };
    }

    const started = performance.now();
    const resolved = await mapLimit(tokens, CONCURRENCY, (segment) => resolveOne(segment, options, log));
    const maxText = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    const maxToken = options.maxTokenChars ?? DEFAULT_MAX_TOKEN_CHARS;
    const redact = options.redact ?? redactSecretsInText;
    const capturedAt = (options.now?.() ?? new Date()).toISOString();
    const records: TransclusionToken[] = [];
    let added = 0;
    let index = 0;
    let output = "";

    for (const segment of segments) {
        if (segment.type === "text") {
            output += segment.value;
            continue;
        }

        const entry = resolved[index++];
        let error = entry.error;
        let markdown = "";
        let content = "";
        let signature: string | undefined;
        let truncated = false;
        let provenance: Record<string, unknown> | undefined;

        if (!error && entry.result) {
            const redacted = redact(entry.result.markdown);
            const cut = capChars(redacted, maxToken);
            content = cut.text;
            truncated = cut.truncated;
            signature = contentSignature(redacted);
            provenance = {
                capturedAt,
                ...(entry.result.source ? { source: entry.result.source } : {}),
                token: segment.raw,
                recheck: recheckCommand(segment.raw),
                ...(entry.result.shown ? { shown: entry.result.shown } : {}),
                ...(truncated ? { truncatedAt: maxToken } : {}),
            };
            // After a quote the footer needs a blank line, or markdown's lazy continuation pulls it into the quote.
            const gap = /(^|\n)>[^\n]*$/.test(content) ? "\n\n" : "\n";
            markdown = entry.result.block
                ? `${content}${gap}${redact(provenanceFooter({ capturedAt, result: entry.result, raw: segment.raw, truncated, action: entry.action }))}`
                : content;

            if (added + markdown.length > maxText) {
                error = `text size cap reached (${maxText} chars for all tokens of one text); this token was skipped`;
            }
        }

        // The footer and a failure marker quote the raw token and its source, so they are masked too.
        const replacement = error
            ? redact(failureMarker(segment, error))
            : placed(markdown, segment, entry.result?.block);
        added += error ? 0 : markdown.length;
        output += replacement;

        const record: TransclusionToken = {
            raw: segment.raw,
            kind: segment.kind,
            ...(entry.action ? { action: entry.action } : {}),
            ...(segment.alias ? { alias: segment.alias } : {}),
            params: entry.params,
            ok: !error,
            ...(error ? { error } : {}),
            ...(entry.result?.meta || provenance
                ? { meta: { ...entry.result?.meta, ...(provenance ? { provenance } : {}) } }
                : {}),
            capturedAt,
            cwd: options.cwd,
            ...(signature && !error ? { signature } : {}),
            ...(entry.action === "verify" && !error ? { snapshot: content } : {}),
            chars: replacement.length,
            ms: entry.ms,
            ...(truncated ? { truncated } : {}),
        };
        records.push(record);

        if (error) {
            (options.callerReports ? log.debug : log.warn).call(
                log,
                { kind: record.kind, raw: record.raw, error },
                "transclusion failed"
            );
        } else {
            log.debug(
                {
                    kind: record.kind,
                    params: entry.values,
                    ms: record.ms,
                    chars: record.chars,
                    truncated,
                    meta: record.meta,
                },
                "transclusion resolved"
            );
        }
    }

    const failed = records.filter((record) => !record.ok).length;
    (options.callerReports ? log.debug : log.info).call(
        log,
        {
            tokens: records.length,
            resolved: records.length - failed,
            failed,
            chars: added,
            ms: Math.round(performance.now() - started),
        },
        "transclude finished"
    );

    if (failed > 0 && options.onFailure === "throw") {
        throw new TranscludeFailedError(records.filter((record) => !record.ok));
    }

    return { text: trimAddedEdges(text, output), tokens: records };
}

/** sha256 of the resolved content before the footer and the size cap: what `recheck()` compares. */
export function contentSignature(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

/** The shell line that re-resolves a token, single-quoted so a `"` inside it survives. */
export function recheckCommand(raw: string): string {
    return `tools question tokens resolve '${raw.replace(/'/g, "'\\''")}'`;
}

function formatCaptureTime(iso: string): string {
    return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The one-line footer under a block: when it was captured, from exactly what, how much is shown,
 * and the token that re-checks it live. A reader opening the question later sees the text is frozen.
 */
export function provenanceFooter({
    capturedAt,
    result,
    raw,
    truncated,
    action,
}: {
    capturedAt: string;
    result: TransclusionResult;
    raw: string;
    truncated: boolean;
    action?: TransclusionAction;
}): string {
    const parts = [`captured ${formatCaptureTime(capturedAt)}`];

    if (result.source) {
        parts.push(result.source);
    }

    if (result.shown) {
        parts.push(`showing ${result.shown.shown} of ${result.shown.total} ${result.shown.unit}`);
    }

    if (truncated) {
        parts.push("cut for size");
    }

    parts.push(`${action === "verify" ? "live re-check" : "re-check"}: ${codeSpan(raw)}`);
    return `_↳ ${parts.join(" · ")}_`;
}

async function resolveOne(segment: TokenSegment, options: TranscludeOptions, log: Logger): Promise<Resolved> {
    const started = performance.now();
    const base = { segment, params: segment.params };
    const elapsed = (): number => Math.round(performance.now() - started);

    if (segment.error) {
        return { ...base, error: segment.error, ms: 0 };
    }

    const definition = options.registry.get(segment.kind);

    if (!definition) {
        return { ...base, error: unknownKindMessage(segment.kind, options.registry), ms: 0 };
    }

    const action = definition.action ?? "substitute";

    const timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new TransclusionError(`timed out after ${timeoutMs} ms`)), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;

    try {
        const params = validateTransclusionParams({ definition, raw: segment.params, cwd: options.cwd });
        const ctx: TransclusionContext = {
            cwd: options.cwd,
            logger: log.child({ kind: definition.name }),
            signal,
            deadline: Date.now() + timeoutMs,
            maxChars: options.maxTokenChars ?? DEFAULT_MAX_TOKEN_CHARS,
            redact: options.redact ?? redactSecretsInText,
            run: options.run ?? defaultRunner,
            fetch: options.fetch ?? fetch,
            ...(options.assetDir ? { assetDir: options.assetDir } : {}),
            ...(options.preview ? { preview: true } : {}),
        };
        const result = await Promise.race([definition.resolve(params, ctx), rejectOnAbort(signal)]);

        // A resolver that answers from its own abort handler (a killed child's partial output) must not win.
        if (signal.aborted) {
            throw signal.reason ?? new TransclusionError("cancelled");
        }

        return { ...base, action, result, values: params.values(), ms: elapsed() };
    } catch (error) {
        if (!(error instanceof TransclusionError) && !signal.aborted) {
            log.warn({ error, kind: segment.kind, raw: segment.raw }, "transclusion resolver threw");
        }

        return { ...base, action, error: reasonOf(error, signal), ms: elapsed() };
    } finally {
        clearTimeout(timer);
    }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
        const fail = (): void => reject(signal.reason ?? new TransclusionError("cancelled"));

        if (signal.aborted) {
            fail();
            return;
        }

        signal.addEventListener("abort", fail, { once: true });
    });
}

function reasonOf(error: unknown, signal: AbortSignal): string {
    if (signal.aborted && signal.reason instanceof Error) {
        return signal.reason.message;
    }

    return error instanceof Error ? error.message : String(error);
}

/** Drops the blank lines a block placement added at the very start or end, never ones the author wrote. */
function trimAddedEdges(original: string, output: string): string {
    const start = original.startsWith("\n") ? output : output.replace(/^\n+/, "");
    return original.endsWith("\n") ? start : start.replace(/\n+$/, "");
}

function joinLiterals(segments: Segment[]): string {
    return segments.map((segment) => (segment.type === "text" ? segment.value : segment.raw)).join("");
}

/**
 * A block goes into a paragraph of its own: blank lines around it, so a quote or a fence neither
 * swallows the next line (markdown's lazy continuation) nor glues onto the sentence before it. An
 * inline result replaces the token as it is.
 */
function placed(markdown: string, segment: TokenSegment, block: boolean | undefined): string {
    if (!block) {
        return markdown;
    }

    return segment.standalone ? `\n${markdown}\n` : `\n\n${markdown}\n\n`;
}

export function failureMarker(segment: Pick<TokenSegment, "raw" | "standalone">, error: string): string {
    const marker = `⚠️ unresolved ${codeSpan(segment.raw)}: ${error}`;
    return segment.standalone ? `\n> ${marker}\n` : marker;
}

/** A code span that survives backticks inside the token. */
export function codeSpan(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Cuts at `max` characters with a visible marker. A cut inside a code fence closes the fence first,
 * so the rest of the text is not swallowed into it.
 */
export function capChars(text: string, max: number): { text: string; truncated: boolean } {
    if (text.length <= max) {
        return { text, truncated: false };
    }

    let cut = text.slice(0, max);
    const lastNewline = cut.lastIndexOf("\n");

    if (lastNewline > max / 2) {
        cut = cut.slice(0, lastNewline);
    }

    const fences = cut.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? [];
    const open = fences.length % 2 === 1 ? fences[fences.length - 1].trim() : null;
    const marker = `… [truncated: ${text.length - cut.length} more chars, cap ${max}]`;
    return { text: `${cut}\n${open ? `${open}\n` : ""}${marker}`, truncated: true };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;

    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
