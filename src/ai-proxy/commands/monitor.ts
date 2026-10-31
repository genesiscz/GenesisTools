/**
 * `tools ai-proxy monitor`: the proxy's requests and compaction events as they happen, one line each, so a person or
 * an agent's Monitor tool can watch a session without re-running `calls` and `session`. `--since` prints the recent
 * past first; the stream then follows both files until Ctrl-C.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompactionEvent, compactionEventsPath } from "@app/ai-proxy/lib/sessions/compaction-events";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { PrefixDiff } from "@app/ai-proxy/lib/usage/prefix-diff";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { hitPercent, splitPromptTokens } from "@genesiscz/utils/ai/usage/cache-stats";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export interface MonitorOptions {
    /** Session id prefix: the proxy record, Claude Code's own id, or a request's session tag. */
    session?: string;
    /** Substring of the proxy or upstream model id. */
    model?: string;
    /** Only compaction events and compaction requests. */
    compaction?: boolean;
    /** Only requests at least this many seconds long (events always print). */
    slow?: number;
    /** Only failed requests and warning events. */
    errors?: boolean;
    /** Print the last N minutes first. */
    since?: number;
    /** One JSON object per line: `{ "type": "request" | "compaction", ... }`. */
    json?: boolean;
    /** Print the backlog and stop (no follow). */
    once?: boolean;
}

const WARN_EVENTS = new Set(["retry", "missed", "background-wasted", "background-failed", "blocked", "cache-reset"]);

function requestsFile(): string {
    return join(getAiProxyStorage().getBaseDir(), "usage", "requests.jsonl");
}

function sessionMatches(prefix: string | undefined, ...ids: Array<string | undefined>): boolean {
    return !prefix || ids.some((id) => id?.startsWith(prefix));
}

export function requestPasses(record: UsageRequestRecord, options: MonitorOptions): boolean {
    if (!sessionMatches(options.session, record.tags?.session)) {
        return false;
    }

    if (options.model && !`${record.proxyModel} ${record.upstreamModel}`.includes(options.model)) {
        return false;
    }

    if (options.compaction && !record.compaction) {
        return false;
    }

    if (options.slow !== undefined && record.elapsedMs < options.slow * 1000) {
        return false;
    }

    return !options.errors || record.status >= 400 || Boolean(record.error || record.failure);
}

export function eventPasses(event: CompactionEvent, options: MonitorOptions): boolean {
    if (!sessionMatches(options.session, event.session, event.claudeSession)) {
        return false;
    }

    if (options.model && !(event.model ?? "").includes(options.model)) {
        return false;
    }

    return !options.errors || WARN_EVENTS.has(event.kind);
}

function clock(ts: string): string {
    return new Date(ts).toTimeString().slice(0, 8);
}

function k(value: number | undefined): string {
    if (value === undefined) {
        return "?";
    }

    return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
}

function seconds(ms: number | undefined): string {
    return ms === undefined ? "" : `${(ms / 1000).toFixed(1)}s`;
}

export function formatRequest(record: UsageRequestRecord): string {
    const usage = record.usage ?? {};
    // Both conventions: Anthropic's cache read and write sit beside prompt_tokens, OpenAI's cached part is inside it.
    const split = splitPromptTokens(usage);
    const input = split.uncached + split.cacheRead + split.cacheWrite;
    const percent = hitPercent(split);
    const hit = percent === undefined ? "-" : `${Math.round(percent)}%`;
    const status = record.status >= 400 || record.error ? pc.red(String(record.status)) : String(record.status);
    const flags = [
        record.compaction ? pc.magenta(record.path.includes("background") ? "BG-COMPACT" : "COMPACT") : "",
        record.failure ? pc.red(`failure=${record.failure}`) : "",
        record.rateLimited ? pc.yellow("rate-limited") : "",
        percent !== undefined && percent < 50 ? missCause(record.prefix) : "",
    ]
        .filter(Boolean)
        .join(" ");

    return [
        clock(record.ts),
        "req",
        (record.tags?.session ?? "-").slice(0, 8),
        record.upstreamModel,
        record.effort ?? "",
        status,
        seconds(record.elapsedMs),
        `ctx ${k(input)}`,
        `hit ${hit}`,
        `out ${k(usage.completion_tokens)}`,
        flags,
    ]
        .filter(Boolean)
        .join("  ");
}

/** What a missed request changed against its thread's previous request (`prefix` in the ledger row). */
function missCause(prefix: PrefixDiff | undefined): string {
    if (!prefix || prefix.part === "first") {
        return "";
    }

    if (prefix.part === "none") {
        return pc.yellow("changed nothing (upstream miss)");
    }

    if (prefix.part === "input") {
        return pc.yellow(`changed input#${prefix.index}/${prefix.of} ${prefix.itemType}`);
    }

    return pc.yellow(`changed ${prefix.part}`);
}

export function formatEvent(event: CompactionEvent): string {
    const kind = WARN_EVENTS.has(event.kind)
        ? pc.yellow(`compaction:${event.kind}`)
        : pc.cyan(`compaction:${event.kind}`);
    const tokens =
        event.inputTokens !== undefined
            ? `ctx ${k(event.inputTokens)} cached ${k(event.cachedTokens)} out ${k(event.outputTokens)}`
            : "";

    return [
        clock(event.ts),
        kind,
        (event.session ?? event.claudeSession ?? "-").slice(0, 8),
        event.model ?? "",
        event.mode ? `mode=${event.mode}` : "",
        event.thread ? pc.dim(`thread=${event.thread}`) : "",
        event.id ?? "",
        seconds(event.durationMs),
        tokens,
        event.tailItems !== undefined ? `tail=${event.tailItems}` : "",
        event.reason ? `— ${event.reason}` : "",
        event.client ? pc.dim(event.client.split(" ")[0] ?? "") : "",
    ]
        .filter(Boolean)
        .join("  ");
}

/**
 * The rows since `since`, and the byte offset after the last complete line: the live tail starts there, so a row
 * appended while the backlog prints, or a line the proxy was still writing, is read by the tail instead of lost.
 */
export function readBacklog<T>(path: string, since: number): { rows: T[]; end: number } {
    if (!existsSync(path)) {
        return { rows: [], end: 0 };
    }

    const bytes = readFileSync(path);
    const end = bytes.lastIndexOf(0x0a) + 1;
    const rows: T[] = [];

    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            const row = SafeJSON.parse(line, { strict: true }) as T & { ts?: string };

            if (typeof row.ts === "string" && Date.parse(row.ts) >= since) {
                rows.push(row);
            }
        } catch {
            // A malformed row in the ledger: skip it, the rest still prints.
        }
    }

    return { rows, end };
}

export function runMonitorCommand(options: MonitorOptions): void {
    const print = (type: "request" | "compaction", row: UsageRequestRecord | CompactionEvent) => {
        if (options.json) {
            out.println(SafeJSON.stringify({ type, ...row }) ?? "");
            return;
        }

        out.println(
            type === "request" ? formatRequest(row as UsageRequestRecord) : formatEvent(row as CompactionEvent)
        );
    };
    const onRequest = (record: UsageRequestRecord) => {
        if (requestPasses(record, options)) {
            print("request", record);
        }
    };
    const onEvent = (event: CompactionEvent) => {
        if (eventPasses(event, options)) {
            print("compaction", event);
        }
    };

    let requestsFrom: number | undefined;
    let eventsFrom: number | undefined;

    if (options.since !== undefined) {
        const since = Date.now() - options.since * 60_000;
        const requests = readBacklog<UsageRequestRecord>(requestsFile(), since);
        const events = readBacklog<CompactionEvent>(compactionEventsPath(), since);
        requestsFrom = requests.end;
        eventsFrom = events.end;
        const backlog = [
            ...requests.rows.map((row) => ({ type: "request" as const, row })),
            ...events.rows.map((row) => ({ type: "compaction" as const, row })),
        ].sort((a, b) => Date.parse(a.row.ts) - Date.parse(b.row.ts));

        for (const entry of backlog) {
            if (entry.type === "request") {
                onRequest(entry.row as UsageRequestRecord);
            } else {
                onEvent(entry.row as CompactionEvent);
            }
        }
    }

    if (options.once) {
        return;
    }

    if (!options.json) {
        out.println(pc.dim("Following ai-proxy requests and compaction events (Ctrl-C to stop)"));
    }

    // A monitor only watches: a missing ledger is waited for, never created.
    new FileTailer<UsageRequestRecord>(
        requestsFile(),
        { onLine: onRequest },
        { from: requestsFrom, create: false }
    ).start();
    new FileTailer<CompactionEvent>(
        compactionEventsPath(),
        { onLine: onEvent },
        { from: eventsFrom, create: false }
    ).start();
}
