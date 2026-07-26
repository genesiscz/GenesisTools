/**
 * `tools ai-proxy calls` — query the request index and open full transcripts.
 *
 * The index (`usage/requests.jsonl`) is one line per proxied call and is cheap
 * to scan; the transcript is the full prompt + answer for a single call. This
 * command filters the index (by session/stage/model/slowness/time) and can then
 * print the matching transcript, so debugging is "filter, then open", never
 * "re-run and hope it happens again".
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { formatTimeline } from "@app/ai-proxy/lib/usage/call-timeline";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

export interface CallsOptions {
    session?: string;
    stage?: string;
    label?: string;
    model?: string;
    /** Only calls at least this many seconds long. */
    slowerThan?: number;
    /** Only calls from the last N minutes. */
    sinceMinutes?: number;
    limit: number;
    /** Print the full transcript of every matched call instead of the table. */
    show?: boolean;
    /** Show the per-call phase breakdown instead of the token table. */
    timeline?: boolean;
    json?: boolean;
}

function requestsPath(): string {
    return join(getAiProxyStorage().getBaseDir(), "usage", "requests.jsonl");
}

/** Bytes pulled per pass when walking the index backwards. */
const TAIL_CHUNK_BYTES = 512 * 1024;

/**
 * Newest-first scan of the append-only index, stopping as soon as `limit`
 * matches are in hand or a line predates the cutoff. The index grows without
 * bound (one line per proxied call, each now carrying a transcript ref and a
 * timeline), so reading and parsing all of it made `--since 5` cost as much as
 * the entire history.
 */
export function collectRecords(
    options: CallsOptions,
    cutoff?: number,
    path = requestsPath(),
    chunkBytes = TAIL_CHUNK_BYTES
): UsageRequestRecord[] {
    if (!existsSync(path)) {
        return [];
    }

    const matched: UsageRequestRecord[] = [];
    const fd = openSync(path, "r");

    try {
        let end = statSync(path).size;
        let carry = "";

        while (end > 0 && matched.length < options.limit) {
            const start = Math.max(0, end - chunkBytes);
            const buffer = Buffer.alloc(end - start);
            readSync(fd, buffer, 0, buffer.length, start);
            end = start;

            const lines = `${buffer.toString("utf-8")}${carry}`.split("\n");
            // The first line is cut off mid-record unless we reached the file head.
            carry = start > 0 ? (lines.shift() ?? "") : "";

            for (let i = lines.length - 1; i >= 0 && matched.length < options.limit; i--) {
                const line = lines[i];
                if (!line.trim()) {
                    continue;
                }

                let record: UsageRequestRecord;
                try {
                    record = SafeJSON.parse(line, { strict: true }) as UsageRequestRecord;
                } catch (err) {
                    logger.debug({ err }, "ai-proxy calls: skipped unparseable index line");
                    continue;
                }

                // Chronological file: once we are before the cutoff, so is everything left.
                if (cutoff !== undefined && new Date(record.ts).getTime() < cutoff) {
                    return matched.reverse();
                }

                if (matches(record, options, cutoff)) {
                    matched.push(record);
                }
            }
        }
    } finally {
        closeSync(fd);
    }

    return matched.reverse();
}

function matches(record: UsageRequestRecord, options: CallsOptions, cutoff?: number): boolean {
    if (cutoff !== undefined && new Date(record.ts).getTime() < cutoff) {
        return false;
    }

    if (options.session && !(record.tags?.session ?? "").includes(options.session)) {
        return false;
    }

    if (options.stage && (record.tags?.stage ?? "") !== options.stage) {
        return false;
    }

    if (options.label && !(record.tags?.label ?? "").includes(options.label)) {
        return false;
    }

    if (options.model && !record.proxyModel.includes(options.model)) {
        return false;
    }

    if (options.slowerThan !== undefined && record.elapsedMs < options.slowerThan * 1000) {
        return false;
    }

    return true;
}

interface TranscriptEntry {
    uuid: string;
    callId?: string;
    type: string;
    message?: {
        role?: string;
        content?: { type: string; text?: string; thinking?: string }[];
        usage?: Record<string, unknown>;
    };
}

/** Pull one call's entries out of its session JSONL and print prompt, thinking, answer. */
function printTranscript(record: UsageRequestRecord): void {
    const ref = record.transcript;
    if (!ref || !existsSync(ref.file)) {
        out.println(pc.yellow(`no transcript on disk for ${record.ts} (${record.proxyModel})`));
        return;
    }

    const entries: TranscriptEntry[] = [];
    for (const line of readFileSync(ref.file, "utf-8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            entries.push(SafeJSON.parse(line, { strict: true }) as TranscriptEntry);
        } catch (err) {
            logger.debug({ err }, "ai-proxy calls: skipped unparseable transcript line");
        }
    }

    const assistant = entries.find((entry) => entry.uuid === ref.uuid);
    const callEntries = assistant?.callId
        ? entries.filter((entry) => entry.callId === assistant.callId)
        : entries.filter((entry) => entry.uuid === ref.uuid);

    renderCliHeader(
        `${record.tags?.label ?? "call"} · ${(record.elapsedMs / 1000).toFixed(1)}s`,
        `${record.proxyModel} · ${record.ts}`
    );
    out.println(pc.dim(`${ref.file}  (uuid ${ref.uuid})`));
    if (record.timeline) {
        out.println(pc.cyan(formatTimeline(record.timeline)));
    }

    for (const entry of callEntries) {
        for (const block of entry.message?.content ?? []) {
            const isThinking = block.type === "thinking";
            renderCliSection(isThinking ? "THINKING" : (entry.message?.role ?? entry.type).toUpperCase());
            out.println(isThinking ? pc.dim(block.thinking ?? "") : (block.text ?? ""));
        }
    }

    out.println("");
}

export function runCallsCommand(options: CallsOptions): void {
    const cutoff = options.sinceMinutes ? Date.now() - options.sinceMinutes * 60_000 : undefined;
    const matched = collectRecords(options, cutoff);

    if (options.json) {
        out.result(matched);
        return;
    }

    if (matched.length === 0) {
        out.log.info("No calls matched. Transcripts are written per call; check filters or run something first.");
        return;
    }

    if (options.show) {
        for (const record of matched) {
            printTranscript(record);
        }

        return;
    }

    renderCliHeader("Proxy calls", `${matched.length} matched · newest last`);

    if (options.timeline) {
        const phases = createBoxTable(["TIME", "LABEL", "SECS", "DISPATCH", "TTFB", "THINK", "TEXT", "CHARS"]);
        for (const record of matched) {
            const t = record.timeline;
            phases.push([
                record.ts.slice(11, 19),
                truncateDisplay(record.tags?.label, 28),
                (record.elapsedMs / 1000).toFixed(1),
                t?.upstreamHeadersMs !== undefined ? `${t.upstreamHeadersMs}ms` : "—",
                t?.firstByteMs !== undefined ? `${t.firstByteMs}ms` : "—",
                t?.thinkingMs !== undefined ? `${(t.thinkingMs / 1000).toFixed(1)}s` : "—",
                t?.textMs !== undefined ? `${(t.textMs / 1000).toFixed(1)}s` : "—",
                `${t?.thinkingChars ?? 0}/${t?.textChars ?? 0}`,
            ]);
        }

        out.println(phases.toString());
        renderCliSection("Columns");
        out.println(
            "DISPATCH = receipt → upstream headers · TTFB = receipt → first body byte · " +
                "THINK/TEXT = span from first to last token of each · CHARS = thinking/text"
        );
        return;
    }

    const table = createBoxTable(["TIME", "STAGE", "LABEL", "MODEL", "SECS", "IN", "OUT", "STATUS"]);
    for (const record of matched) {
        const secs = record.elapsedMs / 1000;
        table.push([
            record.ts.slice(11, 19),
            truncateDisplay(record.tags?.stage, 12),
            truncateDisplay(record.tags?.label, 28),
            truncateDisplay(record.proxyModel, 34),
            secs >= 30 ? pc.red(secs.toFixed(1)) : secs.toFixed(1),
            String(record.usage?.prompt_tokens ?? "—"),
            String(record.usage?.completion_tokens ?? "—"),
            // A dropped stream answers 200 at the header and then dies, so status
            // alone would show it as a success.
            record.failure
                ? pc.red(`${record.status} dropped`)
                : record.status === 200
                  ? pc.green("200")
                  : pc.red(String(record.status)),
        ]);
    }

    out.println(table.toString());

    const slowest = [...matched].sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
    if (slowest) {
        renderCliSection("Slowest call");
        out.println(
            `${(slowest.elapsedMs / 1000).toFixed(1)}s · ${slowest.tags?.label ?? "unlabelled"} · ${slowest.proxyModel}`
        );
        if (slowest.timeline) {
            out.println(pc.cyan(formatTimeline(slowest.timeline)));
        }
        out.println(
            pc.dim(
                slowest.transcript
                    ? `${slowest.transcript.file}  (uuid ${slowest.transcript.uuid})`
                    : "no transcript (AI_PROXY_TRANSCRIPTS=0?)"
            )
        );
    }
}
