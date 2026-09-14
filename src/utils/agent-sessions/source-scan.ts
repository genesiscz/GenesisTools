import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSourceIssue } from "./types";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue | undefined };

/** The three coercions every reader needs; they were copy-pasted into eight of them. */
export function asRecord(value: JsonValue | undefined): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function text(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : "";
}

export function date(value: JsonValue | undefined): Date | undefined {
    const candidate = text(value);

    if (!candidate) {
        return;
    }

    const parsed = new Date(candidate);

    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export interface ScannedJsonlRecord {
    position: number;
    line: number;
    original: string;
    value: JsonValue;
}

export interface ScanJsonlOptions {
    path: string;
    signal?: AbortSignal;
    onIssue?: (issue: NativeSourceIssue) => void;
}

/**
 * Whether an issue means the file's metadata cannot be stored. Every issue does, except a
 * malformed record in the MIDDLE of the file: that is permanent (Claude Code wrote bad JSON
 * months ago), so a read that treated it as incomplete stored nothing, re-read the whole
 * file on every search and re-warned about the same line forever (2 files, 5.4 MB, on the
 * live index 2026-09-10). A partial final record is a file mid-write and still blocks.
 */
export function blocksMetadata(issue: { message: string }): boolean {
    return !/^Malformed record at line \d+$/.test(issue.message);
}

function report(options: ScanJsonlOptions, message: string): void {
    options.onIssue?.({ path: options.path, message });
}

function isMissing(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === "NotFoundError" || ("code" in error && (error as Error & { code?: string }).code === "ENOENT"))
    );
}

export async function* scanJsonlRecords(options: ScanJsonlOptions): AsyncGenerator<ScannedJsonlRecord> {
    const reader = Bun.file(options.path).stream().getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let line = 0;
    let position = 0;

    function parse(original: string, partial: boolean): ScannedJsonlRecord | undefined {
        if (!original.trim()) {
            return;
        }
        try {
            return {
                position,
                line,
                original,
                value: SafeJSON.parse(original, { strict: true }) as JsonValue,
            };
        } catch {
            report(options, `${partial ? "Partial final record" : "Malformed record"} at line ${line}`);
        }
    }

    try {
        while (true) {
            options.signal?.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            pending += decoder.decode(chunk.value, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline >= 0) {
                const original = pending.slice(0, newline).replace(/\r$/, "");
                pending = pending.slice(newline + 1);
                line++;
                const record = parse(original, false);
                if (record) {
                    yield record;
                    position++;
                }
                newline = pending.indexOf("\n");
            }
        }

        pending += decoder.decode();
        if (pending) {
            line++;
            const record = parse(pending.replace(/\r$/, ""), true);
            if (record) {
                yield record;
            }
        }
    } catch (error) {
        options.signal?.throwIfAborted();
        report(options, isMissing(error) ? "Source missing" : "Source read failed");
    } finally {
        await reader.cancel();
    }
}
