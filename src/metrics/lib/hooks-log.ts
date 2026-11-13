import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MAX_INGEST_EVENTS } from "@genesiscz/utils/metrics/protocol";
import type { MetricsServiceClient } from "@genesiscz/utils/metrics/service-client";
import type { MetricEvent } from "@genesiscz/utils/metrics/types";
import { isObject } from "@genesiscz/utils/object";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import {
    INJECTION_METRIC,
    INJECTION_PROJECT,
    injectionSource,
} from "../../../plugins/genesis-tools-mods/hooks/metrics";

const { log } = logger.scoped("metrics-import");

const CHUNK_BYTES = 1024 * 1024;

/** The old hook ledger log: one line per hook answer, with no session id. */
export function defaultHooksLogPath(): string {
    return genesisToolsDir("agents", "mods-log", "hooks.jsonl");
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
}

export type HooksLogLine = { kind: "event"; event: MetricEvent } | { kind: "skip" } | { kind: "bad"; reason: string };

/**
 * One line of the old log as an `agent-context / hook.injection` event: `value` is the line's characters, one event
 * per line (the old log kept no per-entry length). Old lines have no session (`session: null`). A line with no
 * character count (the dedupe switch) is skipped.
 */
export function hooksLogLine(line: string): HooksLogLine {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch {
        return { kind: "bad", reason: "no JSON" };
    }

    if (!isObject(parsed)) {
        return { kind: "bad", reason: "not an object" };
    }

    if (typeof parsed.chars !== "number" || typeof parsed.event !== "string") {
        return { kind: "skip" };
    }

    const heads = strings(parsed.heads);
    const block = typeof parsed.block === "string" ? parsed.block : undefined;
    const dropped = strings(parsed.dropped);

    return {
        kind: "event",
        event: {
            project: INJECTION_PROJECT,
            metric: INJECTION_METRIC,
            ...(typeof parsed.at === "string" ? { at: parsed.at } : {}),
            value: parsed.chars,
            dims: {
                session: null,
                agent: typeof parsed.agent === "string" ? parsed.agent : "main",
                agentType: null,
                event: parsed.event,
                tool: typeof parsed.tool === "string" ? parsed.tool : null,
                source: injectionSource(heads[0] ?? block ?? ""),
                rule: null,
                kind: heads.length === 0 && block ? "block" : "context",
                harness: "claude",
                dropped: dropped.length > 0,
            },
            context: { heads, ...(block ? { block } : {}), ...(dropped.length ? { dropped } : {}) },
        },
    };
}

export interface ImportSummary {
    path: string;
    from: number;
    to: number;
    lines: number;
    accepted: number;
    rejected: number;
    skipped: number;
    bad: number;
}

function readChunk(path: string, offset: number, length: number): Buffer {
    const fd = openSync(path, "r");

    try {
        const buffer = Buffer.alloc(length);
        return buffer.subarray(0, readSync(fd, buffer, 0, length, offset));
    } finally {
        closeSync(fd);
    }
}

/**
 * Where the line that goes on past `from` ends (the offset after its newline), read a chunk at a time so a long line
 * is never held whole; undefined when the file ends first (a line its writer has not finished).
 */
function endOfLine(path: string, from: number, size: number): number | undefined {
    for (let at = from; at < size; at += CHUNK_BYTES) {
        const newline = readChunk(path, at, Math.min(CHUNK_BYTES, size - at)).indexOf(0x0a);

        if (newline >= 0) {
            return at + newline + 1;
        }
    }

    return undefined;
}

/**
 * Reads the old log from the offset the store holds for it, whole lines only, and sends each batch through `ingest`
 * with its cursor, so the events and the new offset are written together and a second run adds only new lines.
 */
export async function importHooksLog(client: MetricsServiceClient, file: string): Promise<ImportSummary> {
    const path = resolve(file);
    const status = await client.call("status", {});
    const from = status.spool.files.find((entry) => entry.path === path)?.offset ?? 0;
    const size = statSync(path).size;
    const summary: ImportSummary = { path, from, to: from, lines: 0, accepted: 0, rejected: 0, skipped: 0, bad: 0 };
    let offset = from;

    const send = async (events: MetricEvent[], end: number, lines: number): Promise<void> => {
        const answer = await client.call("ingest", { events, cursor: { path, start: offset, end, lines } });

        if ("cursorMismatch" in answer) {
            throw new Error(
                `the store holds offset ${answer.cursorMismatch.stored} for ${path}, not ${offset}: another import ran at the same time`
            );
        }

        summary.accepted += answer.accepted;
        summary.rejected += answer.rejected;
        summary.lines += lines;
        offset = end;
        summary.to = offset;
    };

    while (offset < size) {
        const chunk = readChunk(path, offset, Math.min(CHUNK_BYTES, size - offset));
        const last = chunk.lastIndexOf(0x0a);

        if (last < 0) {
            // No newline in a whole chunk: one line longer than a chunk, or the last line, still being written.
            const end = endOfLine(path, offset + chunk.length, size);

            if (end === undefined) {
                break;
            }

            // Skipped and counted as bad, but the cursor moves past it, so the lines after it are imported.
            summary.bad += 1;
            log.warn(
                { path, line: summary.lines + 1, bytes: end - offset },
                `a hooks log line longer than ${CHUNK_BYTES} bytes was skipped`
            );
            await send([], end, 1);
            continue;
        }

        const lines = chunk.subarray(0, last).toString("utf8").split("\n");
        const events: MetricEvent[] = [];

        for (const [index, line] of lines.entries()) {
            if (!line.trim()) {
                continue;
            }

            const read = hooksLogLine(line);

            if (read.kind === "event") {
                events.push(read.event);
            } else if (read.kind === "skip") {
                summary.skipped += 1;
            } else {
                summary.bad += 1;
                log.warn(
                    { path, line: summary.lines + index + 1, reason: read.reason },
                    "a hooks log line was skipped"
                );
            }
        }

        if (events.length > MAX_INGEST_EVENTS) {
            throw new Error(`a hooks log chunk of ${events.length} lines is larger than one ingest batch`);
        }

        await send(events, offset + last + 1, lines.length);
    }

    log.debug(summary, "hooks log imported");
    return summary;
}
