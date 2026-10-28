/**
 * What `tools ai-proxy sessions`, `session <id>` and `stats` show: one row per proxied request, read from the request
 * index (`usage/requests.jsonl`), with the cache numbers split once (`splitPromptTokens`) and the cache math shared
 * with session-analyzer (`@genesiscz/utils/ai/usage/cache-stats`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { providerDefinition } from "@app/ai-proxy/lib/providers/registry";
import { splitReasoningEffortSuffix } from "@app/ai-proxy/lib/resolve-model";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { normalizeUsage } from "@app/ai-proxy/lib/usage/extract";
import type { TokenUsage, UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import {
    type CacheCall,
    type CacheLoss,
    type CacheSummary,
    findCacheLosses,
    hitPercent,
    splitPromptTokens,
    summarizeCache,
} from "@genesiscz/utils/ai/usage/cache-stats";
import { readLinesBackwardSync, readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** The upstream routes through ai-proxy (Martin's word "agent"); not the coding-agent harness of a session. */
export const PROXY_AGENTS = ["codex", "claude", "grok", "other"] as const;
export type ProxyAgent = (typeof PROXY_AGENTS)[number];

function isProxyAgent(value: string): value is ProxyAgent {
    return (PROXY_AGENTS as readonly string[]).includes(value);
}

export function agentOf(provider: string): ProxyAgent {
    return providerDefinition(provider)?.agent ?? "other";
}

/**
 * The agent a model id in Claude Code's own transcript names: Claude Code writes the id it sent, so a proxied Codex
 * or Grok model keeps its proxy id (`codex/codex/gpt-6.1-sol`, `martin/grok/grok-4.6`).
 */
export function agentOfModel(model: string): ProxyAgent {
    const id = model.toLowerCase();

    if (id.includes("grok")) {
        return "grok";
    }

    if (/(^|\/)(gpt-|codex|o\d)|(^|[/-])(sol|astra|luna|terra)\b|openai/.test(id)) {
        return "codex";
    }

    return id.includes("claude") || ["opus", "sonnet", "haiku", "fable"].some((alias) => id.includes(alias))
        ? "claude"
        : "other";
}

/** `--agent anthropic` and `--agent claude` name the same route. */
export function parseAgent(value: string | undefined): ProxyAgent | undefined {
    if (value === undefined) {
        return undefined;
    }

    const agent = value === "anthropic" ? "claude" : value;

    if (isProxyAgent(agent)) {
        return agent;
    }

    throw new Error(`unknown agent "${value}" (codex, claude or anthropic, grok, other)`);
}

export interface RequestRow extends CacheCall {
    ts: string;
    agent: ProxyAgent;
    proxyModel: string;
    effort?: string;
    status: number;
    failure?: string;
    ttfbMs?: number;
    elapsedMs: number;
    output: number;
    reasoning: number;
    hit: number | undefined;
    /** False when neither the row nor its transcript reports cache numbers (rows booked before 2026-10-25). */
    cacheKnown: boolean;
    session?: string;
}

function hasCacheNumbers(usage: TokenUsage | undefined): boolean {
    return (
        usage?.cached_prompt_tokens !== undefined ||
        usage?.cache_read_input_tokens !== undefined ||
        usage?.cache_creation_input_tokens !== undefined
    );
}

export function requestRow(record: UsageRequestRecord, fromTranscript?: TokenUsage): RequestRow {
    const usage = hasCacheNumbers(record.usage) ? record.usage : (fromTranscript ?? record.usage);
    const split = splitPromptTokens(usage);
    const { reasoningEffort } = record.proxyModel
        ? splitReasoningEffortSuffix(record.proxyModel)
        : { reasoningEffort: undefined };

    return {
        t: Date.parse(record.ts),
        ts: record.ts,
        agent: agentOf(record.provider),
        model: record.upstreamModel,
        proxyModel: record.proxyModel,
        effort: record.effort ?? reasoningEffort,
        status: record.status,
        failure: record.failure,
        ttfbMs: record.timeline?.firstByteMs,
        elapsedMs: record.elapsedMs,
        input: split.uncached,
        cacheRead: split.cacheRead,
        cacheWrite: split.cacheWrite,
        output: usage?.completion_tokens ?? 0,
        reasoning: usage?.reasoning_tokens ?? 0,
        hit: hitPercent(split),
        cacheKnown: hasCacheNumbers(usage),
        key: record.cacheKey,
        compaction: record.compaction,
        session: record.tags?.session,
    };
}

function requestsPath(): string {
    return join(getAiProxyStorage().getBaseDir(), "usage", "requests.jsonl");
}

/**
 * Index rows newest first back to `sinceMs`, kept when `keep` says so, returned oldest first. The index is
 * append-only and chronological, so the read stops at the first row older than the cutoff.
 */
export function readRequestRecords(
    sinceMs: number,
    keep: (record: UsageRequestRecord) => boolean = () => true,
    path = requestsPath()
): UsageRequestRecord[] {
    if (!existsSync(path)) {
        return [];
    }

    const kept: UsageRequestRecord[] = [];

    for (const line of readLinesBackwardSync(path)) {
        if (!line.trim()) {
            continue;
        }

        let record: UsageRequestRecord;
        try {
            record = SafeJSON.parse(line, { strict: true }) as UsageRequestRecord;
        } catch (err) {
            logger.debug({ err }, "ai-proxy sessions: skipped an unreadable index line");
            continue;
        }

        if (Date.parse(record.ts) < sinceMs) {
            break;
        }

        if (keep(record)) {
            kept.push(record);
        }
    }

    return kept.reverse();
}

/** The transcript file of a row: the recorded path, or `<path>.zst` once the daily pass compressed its day. */
export function transcriptOnDisk(file: string): string | undefined {
    if (existsSync(file)) {
        return file;
    }

    return existsSync(`${file}.zst`) ? `${file}.zst` : undefined;
}

/**
 * Upstream usage for rows booked before the ledger kept cache numbers: the transcript entry of each such row carries
 * the upstream usage as it came (`prompt_tokens_details.cached_tokens`). One read per transcript file, plain or
 * compressed, for every day folder a session spans.
 */
export function usageFromTranscripts(records: UsageRequestRecord[]): Map<string, TokenUsage> {
    const wanted = new Map<string, Set<string>>();

    for (const record of records) {
        if (hasCacheNumbers(record.usage) || !record.transcript) {
            continue;
        }

        const uuids = wanted.get(record.transcript.file) ?? new Set<string>();
        uuids.add(record.transcript.uuid);
        wanted.set(record.transcript.file, uuids);
    }

    const found = new Map<string, TokenUsage>();

    for (const [file, uuids] of wanted) {
        const path = transcriptOnDisk(file);

        if (!path) {
            continue;
        }

        try {
            for (const line of readLinesSync(path)) {
                if (!line.includes('"uuid"')) {
                    continue;
                }

                const entry = SafeJSON.parse(line) as { uuid?: string; message?: { usage?: unknown } };

                if (entry.uuid && uuids.has(entry.uuid)) {
                    const usage = normalizeUsage(entry.message?.usage);

                    if (usage) {
                        found.set(entry.uuid, usage);
                    }
                }
            }
        } catch (err) {
            logger.debug({ err, path }, "ai-proxy sessions: transcript unreadable, its rows keep the ledger numbers");
        }
    }

    return found;
}

export function requestRows(records: UsageRequestRecord[]): RequestRow[] {
    const fromTranscripts = usageFromTranscripts(records);
    return records.map((record) =>
        requestRow(record, record.transcript ? fromTranscripts.get(record.transcript.uuid) : undefined)
    );
}

/** A thread that mixes several subagents (Claude Code transcripts do not say which one wrote a row). */
export const MIXED_SUBAGENT_THREAD = ":subagents";

/**
 * Losses inside each session, never across two sessions. Rows without a session are left out, and so is a thread of
 * mixed subagents: one subagent after another is no cache loss.
 */
export function lossesBySession(rows: RequestRow[]): Array<CacheLoss & { session?: string; row: RequestRow }> {
    const bySession = new Map<string, RequestRow[]>();

    for (const row of rows) {
        if (!row.session || !row.cacheKnown || row.session.endsWith(MIXED_SUBAGENT_THREAD)) {
            continue;
        }

        const list = bySession.get(row.session) ?? [];
        list.push(row);
        bySession.set(row.session, list);
    }

    return [...bySession].flatMap(([session, list]) =>
        findCacheLosses(list).map((loss) => ({ ...loss, session, row: list[loss.call] }))
    );
}

export interface AgentStats extends CacheSummary {
    agent: ProxyAgent;
    sessions: number;
    reasoning: number;
    /** Rows without cache numbers, left out of the hit %. */
    unknownCache: number;
    errors: number;
    /** Median of the per-session hit %. */
    sessionMedian: number | undefined;
    lossesByCause: Record<CacheLoss["cause"], number>;
}

function median(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function statsByAgent(rows: RequestRow[]): AgentStats[] {
    const agents = [...new Set(rows.map((row) => row.agent))].sort();

    return agents.map((agent) => {
        const mine = rows.filter((row) => row.agent === agent);
        const known = mine.filter((row) => row.cacheKnown);
        const losses = lossesBySession(mine);
        const lossesByCause: AgentStats["lossesByCause"] = {
            "key changed": 0,
            "model changed": 0,
            compaction: 0,
            idle: 0,
            unknown: 0,
        };

        for (const loss of losses) {
            lossesByCause[loss.cause]++;
        }

        const sessionHits = [...new Set(known.map((row) => row.session).filter(Boolean))].flatMap((session) => {
            const hit = summarizeCache(
                known.filter((row) => row.session === session),
                0
            ).hitPercent;
            return hit === undefined ? [] : [hit];
        });

        return {
            agent,
            ...summarizeCache(known, losses.length),
            requests: mine.length,
            sessions: new Set(mine.map((row) => row.session).filter(Boolean)).size,
            reasoning: mine.reduce((sum, row) => sum + row.reasoning, 0),
            unknownCache: mine.length - known.length,
            errors: mine.filter((row) => row.status >= 400 || row.failure).length,
            sessionMedian: median(sessionHits),
            lossesByCause,
        };
    });
}
