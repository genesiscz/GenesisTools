/**
 * `tools ai-proxy sessions`, `session <id>` and `stats`: per session and per agent, requests, uncached input, cache
 * read and write, output, reasoning, hit %, cache losses, errors and latency. Hit % = cache read / (uncached + cache
 * read + cache write), the session-analyzer definition. Rows come from the request index; rows booked before the
 * index kept cache numbers take them from their transcript (plain or `.jsonl.zst`).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type AiProxySessionRecord, listSessionRecords, readSessionRecord } from "@app/ai-proxy/lib/sessions/records";
import {
    type AgentStats,
    agentOfModel,
    lossesBySession,
    MIXED_SUBAGENT_THREAD,
    parseAgent,
    type RequestRow,
    readRequestRecords,
    requestRow,
    requestRows,
    statsByAgent,
} from "@app/ai-proxy/lib/sessions/view";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { loadEvents } from "@app/ai-spend/lib/reports/load";
import { hitPercent, summarizeCache } from "@genesiscz/utils/ai/usage/cache-stats";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatLocalDateTimeStamp, parseSince } from "@genesiscz/utils/date";
import { formatTokens, parseDuration } from "@genesiscz/utils/format";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

/** `--since`: a duration back from now (`1d`, `7d`, `90m`) or a local date or time (`2026-10-25`, `08:30`). */
export function sinceToMs(value: string, now = Date.now()): number {
    const duration = parseDuration(value);

    if (duration > 0) {
        return now - duration;
    }

    const at = parseSince(value, new Date(now));

    if (!at) {
        throw new Error(`--since "${value}": use a duration (1d, 7d, 90m) or a date (2026-10-25)`);
    }

    return at.getTime();
}

function pct(value: number | undefined): string {
    return value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function hitCell(value: number | undefined): string {
    if (value === undefined) {
        return "—";
    }

    const text = pct(value);
    return value >= 80 ? pc.green(text) : value >= 50 ? pc.yellow(text) : pc.red(text);
}

function tokens(value: number): string {
    return formatTokens(value);
}

function localTime(ts: string): string {
    return formatLocalDateTimeStamp(ts).slice(11);
}

function sessionRows(record: AiProxySessionRecord, sinceMs = Date.parse(record.createdAt)): UsageRequestRecord[] {
    const ids = new Set([record.id, record.claudeSessionId].filter(Boolean));
    return readRequestRecords(sinceMs, (row) => ids.has(row.tags?.session ?? ""));
}

function lastError(rows: RequestRow[]): string | undefined {
    const failed = rows.filter((row) => row.status >= 400 || row.failure).at(-1);
    return failed ? `${localTime(failed.ts)} ${failed.failure ?? failed.status}` : undefined;
}

export function runSessionsCommand(options: { open?: boolean; since?: string; json?: boolean }): void {
    const sinceMs = sinceToMs(options.since ?? "7d");
    const records = listSessionRecords()
        .filter((record) => !options.open || !record.closedAt)
        .filter((record) => Date.parse(record.lastSeenAt ?? record.createdAt) >= sinceMs)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const oldest = Math.min(...records.map((record) => Date.parse(record.createdAt)), Date.now());
    const ids = new Map<string, AiProxySessionRecord>();

    for (const record of records) {
        ids.set(record.id, record);

        if (record.claudeSessionId) {
            ids.set(record.claudeSessionId, record);
        }
    }

    const rows = requestRows(readRequestRecords(oldest, (row) => ids.has(row.tags?.session ?? "")));
    const summaries = records.map((record) => {
        const mine = rows.filter((row) => ids.get(row.session ?? "") === record);
        const known = mine.filter((row) => row.cacheKnown);
        const summary = summarizeCache(known, lossesBySession(known).length);
        return { record, requests: mine.length, summary, lastError: lastError(mine) };
    });

    if (options.json) {
        out.result(summaries);
        return;
    }

    if (summaries.length === 0) {
        out.log.info(
            `No session records since ${formatLocalDateTimeStamp(sinceMs)} (${join(getAiProxyStorage().getBaseDir(), "sessions")}).`
        );
        return;
    }

    renderCliHeader(
        "Proxy sessions",
        `${summaries.length} since ${formatLocalDateTimeStamp(sinceMs)} · hit = read / all input`
    );
    const table = createBoxTable([
        "SESSION",
        "START",
        "CWD",
        "CODEX",
        "CLAUDE",
        "MODEL",
        "EFFORT",
        "REQ",
        "TOKENS",
        "HIT",
        "LOSS",
        "LAST ERROR",
    ]);

    for (const { record, requests, summary, lastError: error } of summaries) {
        const total = summary.uncached + summary.cacheRead + summary.cacheWrite + summary.output;
        table.push([
            record.closedAt ? pc.dim(record.id) : record.id,
            formatLocalDateTimeStamp(record.createdAt, { seconds: false }),
            truncateDisplay(record.cwd, 28),
            record.codexAccount ?? record.codexProxyAccount ?? "—",
            record.claudeAccount ?? record.claudeProxyAccount ?? "—",
            record.model ?? "—",
            record.effort ?? "—",
            String(requests),
            tokens(total),
            hitCell(summary.hitPercent),
            String(summary.losses),
            error ? pc.red(truncateDisplay(error, 24)) : "—",
        ]);
    }

    out.println(table.toString());
}

function rowCells(row: RequestRow, loss: string | undefined): string[] {
    return [
        localTime(row.ts),
        row.agent,
        truncateDisplay(row.proxyModel, 30),
        row.effort ?? "—",
        row.failure
            ? pc.red(`${row.status} dropped`)
            : row.status === 200
              ? pc.green("200")
              : pc.red(String(row.status)),
        row.ttfbMs === undefined ? "—" : (row.ttfbMs / 1000).toFixed(1),
        (row.elapsedMs / 1000).toFixed(1),
        tokens(row.input),
        row.cacheKnown ? tokens(row.cacheRead) : "?",
        row.cacheKnown ? tokens(row.cacheWrite) : "?",
        tokens(row.output),
        tokens(row.reasoning),
        row.cacheKnown ? hitCell(row.hit) : "?",
        loss ? pc.red(loss) : row.compaction ? pc.dim("compaction") : "",
    ];
}

const ROW_HEADERS = [
    "TIME",
    "AGENT",
    "MODEL",
    "EFFORT",
    "STATUS",
    "TTFB",
    "SECS",
    "IN",
    "READ",
    "WRITE",
    "OUT",
    "REASON",
    "HIT",
    "LOSS",
];

export function runSessionCommand(id: string, options: { follow?: boolean; json?: boolean }): void {
    const record = readSessionRecord(id);

    if (!record) {
        out.log.error(
            `No session record "${id}" (${join(getAiProxyStorage().getBaseDir(), "sessions")}). List them: ${toolCommand("ai-proxy sessions")}`
        );
        process.exitCode = 1;
        return;
    }

    const rows = requestRows(sessionRows(record));
    const known = rows.filter((row) => row.cacheKnown);
    const losses = lossesBySession(rows);
    const lossAt = new Map(losses.map((loss) => [loss.row, `${loss.cause} −${tokens(loss.before - loss.after)}`]));
    const summary = summarizeCache(known, losses.length);

    if (options.json) {
        out.result({ record: { ...record, keyHash: undefined }, summary, losses, rows });
        return;
    }

    renderCliHeader(
        `Session ${record.id}`,
        record.closedAt ? `closed ${formatLocalDateTimeStamp(record.closedAt)}` : "open"
    );
    out.println(
        [
            `started ${formatLocalDateTimeStamp(record.createdAt)} · cwd ${record.cwd ?? "—"}`,
            `codex ${record.codexAccount ?? record.codexProxyAccount ?? "—"} · claude ${record.claudeAccount ?? record.claudeProxyAccount ?? "—"}${record.grokAccount || record.grokProxyAccount ? ` · grok ${record.grokAccount ?? record.grokProxyAccount}` : ""}`,
            `model ${record.model ?? "—"} · effort ${record.effort ?? "—"} · cache key ${record.cacheKeyPolicy ?? "claude-session"}${record.claudeSessionId ? ` · forked as ${record.claudeSessionId}` : ""}`,
            ...(record.moves.length > 0
                ? [`moves ${record.moves.map((move) => `${move.agent} ${move.from}→${move.to}`).join(", ")}`]
                : []),
        ].join("\n")
    );
    out.println(
        `${rows.length} requests · in ${tokens(summary.uncached)} · read ${tokens(summary.cacheRead)} · write ${tokens(summary.cacheWrite)} · out ${tokens(summary.output)} · hit ${pct(summary.hitPercent)} · ${losses.length} losses`
    );

    const table = createBoxTable(ROW_HEADERS);

    for (const row of rows) {
        table.push(rowCells(row, lossAt.get(row)));
    }

    out.println(table.toString());

    if (!options.follow) {
        return;
    }

    renderCliSection("Following (Ctrl-C to stop)");
    const ids = new Set([record.id, record.claudeSessionId].filter(Boolean));
    let previous = rows.at(-1);
    const tailer = new FileTailer<UsageRequestRecord>(
        join(getAiProxyStorage().getBaseDir(), "usage", "requests.jsonl"),
        {
            onLine: (entry) => {
                if (!ids.has(entry.tags?.session ?? "")) {
                    return;
                }

                const row = requestRow(entry);
                const fell = previous && row.cacheKnown && previous.cacheKnown ? previous.cacheRead - row.cacheRead : 0;
                const loss =
                    previous && fell >= 2_048 && fell > 0.5 * previous.cacheRead ? `fell −${tokens(fell)}` : undefined;
                const live = createBoxTable(ROW_HEADERS);
                live.push(rowCells(row, loss));
                out.println(live.toString());
                previous = row;
            },
        }
    );
    tailer.start();
}

function statsTable(stats: AgentStats[]): string {
    const table = createBoxTable([
        "AGENT",
        "SESS",
        "REQ",
        "IN",
        "READ",
        "WRITE",
        "OUT",
        "REASON",
        "HIT",
        "P10",
        "MEDIAN",
        "P90",
        "SESS MED",
        "LOSSES",
        "ERR",
    ]);

    for (const agent of stats) {
        const causes = Object.entries(agent.lossesByCause)
            .filter(([, count]) => count > 0)
            .map(([cause, count]) => `${count} ${cause}`)
            .join(", ");
        table.push([
            agent.agent,
            String(agent.sessions),
            agent.unknownCache > 0 ? `${agent.requests} (${agent.unknownCache} ?)` : String(agent.requests),
            tokens(agent.uncached),
            tokens(agent.cacheRead),
            tokens(agent.cacheWrite),
            tokens(agent.output),
            tokens(agent.reasoning),
            hitCell(agent.hitPercent),
            pct(agent.p10),
            pct(agent.median),
            pct(agent.p90),
            pct(agent.sessionMedian),
            causes || "0",
            String(agent.errors),
        ]);
    }

    return table.toString();
}

/**
 * The same rows from Claude Code's own transcripts (`~/.claude/projects`, read by ai-spend's Claude parser, one row
 * per `message.id`): the "before" numbers of sessions the proxy never tagged, measured by the same code as "after".
 * A session's subagents form one extra thread (`<session>:subagents`), never mixed into the main loop.
 */
export function transcriptRequestRows(sinceMs: number): RequestRow[] {
    return loadEvents({ home: homedir(), sources: ["claude"], minMtimeMs: sinceMs })
        .filter((event) => Date.parse(event.timestamp) >= sinceMs)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .map((event) => {
            const split = {
                uncached: event.inputTokens,
                cacheRead: event.cacheReadTokens,
                cacheWrite: event.cacheCreationTokens,
            };
            return {
                t: Date.parse(event.timestamp),
                ts: event.timestamp,
                agent: agentOfModel(event.model),
                model: event.model,
                proxyModel: event.model,
                status: 200,
                elapsedMs: 0,
                input: split.uncached,
                cacheRead: split.cacheRead,
                cacheWrite: split.cacheWrite,
                output: event.outputTokens,
                reasoning: event.reasoningOutputTokens ?? 0,
                hit: hitPercent(split),
                cacheKnown: true,
                session: event.isSidechain ? `${event.sessionId}${MIXED_SUBAGENT_THREAD}` : event.sessionId,
            };
        });
}

/** `--session` takes a session id or its prefix, on the ledger and on the transcripts alike. */
export function matchesSessionPrefix(session: string | undefined, prefix: string | undefined): boolean {
    return !prefix || (session?.startsWith(prefix) ?? false);
}

export function runStatsCommand(options: {
    session?: string;
    agent?: string;
    since?: string;
    json?: boolean;
    fromTranscripts?: boolean;
}): void {
    const sinceMs = sinceToMs(options.since ?? "7d");
    const agent = parseAgent(options.agent);
    const source = options.fromTranscripts
        ? transcriptRequestRows(sinceMs)
        : requestRows(readRequestRecords(sinceMs, (row) => matchesSessionPrefix(row.tags?.session, options.session)));
    const rows = source.filter(
        (row) => (!agent || row.agent === agent) && matchesSessionPrefix(row.session, options.session)
    );
    const stats = statsByAgent(rows);

    if (options.json) {
        out.result({ since: new Date(sinceMs).toISOString(), stats });
        return;
    }

    if (stats.length === 0) {
        out.log.info(
            `No proxied requests since ${formatLocalDateTimeStamp(sinceMs)}${options.session ? ` for session ${options.session}` : ""}.`
        );
        return;
    }

    renderCliHeader(
        options.fromTranscripts ? "Cache stats from Claude Code transcripts" : "Proxy cache stats",
        `since ${formatLocalDateTimeStamp(sinceMs)} · hit = read / (in + read + write) · P10/MEDIAN/P90 per request`
    );
    out.println(statsTable(stats));
    out.println(
        pc.dim(
            "A loss: the cache read fell by over half and at least 2,048 tokens against the previous request of the same session. ? = rows without cache numbers, left out of the hit %."
        )
    );
}
