import { sessionWaste, WASTE_KINDS, type WasteItem } from "@genesiscz/utils/agent-sessions/analysis/waste";
import { factsOf } from "@genesiscz/utils/agent-sessions/analysis-types";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import { spendBucketKey } from "@genesiscz/utils/ai/usage/series-keys";
import { concurrentMap } from "@genesiscz/utils/async";
import { FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { NO_ACCOUNT } from "./pivot";

/**
 * The waste ledger (design 2026-11-01, step U12, proposal 12): avoidable spend across the sessions that spent in a
 * window, rolled up by any of these dimensions. A session's items come from its reader's analysis facts, cached by
 * the transcript's identity, so a weekly scan re-reads only the transcripts that changed.
 */
export const WASTE_DIMENSIONS = ["kind", "provider", "account", "project", "model", "day", "session"] as const;

export type WasteDimension = (typeof WASTE_DIMENSIONS)[number];

export function isWasteDimension(value: string): value is WasteDimension {
    return (WASTE_DIMENSIONS as readonly string[]).includes(value);
}

export interface WasteGroup {
    key: Partial<Record<WasteDimension, string>>;
    usd: number;
    tokens: number;
    items: number;
}

export interface SessionWasteItem extends WasteItem {
    agent: AttributedEvent["agent"];
    sessionId: string;
    project: string;
    provider: string;
    account: string;
    next: string;
}

export interface SpendWaste {
    by: WasteDimension[];
    groups: WasteGroup[];
    total: { usd: number; tokens: number; items: number };
    /** The costliest items with their session, a fix hint in `evidence`. */
    top: SessionWasteItem[];
    /** Transcripts scanned, and those whose facts the harness cannot give. */
    sessions: { scanned: number; unsupported: number };
}

function isWasteItems(value: unknown): value is WasteItem[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                typeof item === "object" &&
                item !== null &&
                "kind" in item &&
                typeof item.kind === "string" &&
                (WASTE_KINDS as readonly string[]).includes(item.kind)
        )
    );
}

/**
 * Version 2: a sub-agent's own transcript is scanned as its own cache (version 1 cached it as no waste), and a call
 * is priced at its service tier. A version 1 file is ignored, so every transcript is scanned again.
 */
export const WASTE_CACHE_VERSION = 2;

const wasteCache = new FileIdentityCache<WasteItem[]>({
    limit: 20_000,
    persist: {
        path: () => toolDataDir("ai-spend", "cache", "session-waste.json"),
        version: WASTE_CACHE_VERSION,
        isValue: isWasteItems,
    },
});

async function itemsOf(event: AttributedEvent): Promise<{ items: WasteItem[]; supported: boolean }> {
    const identity = fileIdentity(event.file);
    const cached = wasteCache.get(event.file, identity);

    if (cached) {
        return { items: cached, supported: true };
    }

    const analysis = resolveHistoryProvider(event.agent).reader.analysis;
    const [calls, compactions] = await Promise.all([analysis.callTrace(event.file), analysis.compactions(event.file)]);
    const items = sessionWaste({ calls: factsOf(calls), compactions: factsOf(compactions), agent: event.agent });

    // A transcript that could not be read is asked again next time, never cached as a session with no waste.
    if (identity && calls.supported) {
        wasteCache.set(event.file, identity, items);
    }

    return { items, supported: calls.supported };
}

export async function scanSpendWaste(input: {
    events: readonly AttributedEvent[];
    from: number;
    to: number;
    by: readonly WasteDimension[];
    tz: string;
    reportCommand: (sessionId: string) => string;
    top?: number;
}): Promise<SpendWaste> {
    const files = new Map<string, AttributedEvent>();

    for (const event of input.events) {
        if (event.at >= input.from && event.at < input.to && !files.has(event.file)) {
            files.set(event.file, event);
        }
    }

    await wasteCache.load();
    const scanned = await concurrentMap({
        items: [...files.values()],
        fn: itemsOf,
        concurrency: 4,
        onError: (event, err) => logger.debug({ err, file: event.file }, "[ai-spend] waste scan skipped a transcript"),
    });
    await wasteCache.save();

    const groups = new Map<string, WasteGroup>();
    const all: SessionWasteItem[] = [];
    const total = { usd: 0, tokens: 0, items: 0 };
    let unsupported = 0;

    for (const [event, result] of scanned) {
        unsupported += result.supported ? 0 : 1;

        for (const item of result.items) {
            const at = Date.parse(item.t);

            if (at < input.from || at >= input.to) {
                continue;
            }

            const row: SessionWasteItem = {
                ...item,
                agent: event.agent,
                sessionId: event.owner.leadSessionId,
                project: event.owner.project || "?",
                provider: event.provider,
                account: event.account.account?.accountName ?? NO_ACCOUNT,
                next: input.reportCommand(event.owner.leadSessionId),
            };
            const values: Record<WasteDimension, string> = {
                kind: row.kind,
                provider: row.provider,
                account: row.account,
                project: row.project,
                model: row.model,
                day: spendBucketKey(row.t, "day", input.tz),
                session: row.sessionId,
            };
            const key: WasteGroup["key"] = {};

            for (const dimension of input.by) {
                key[dimension] = values[dimension];
            }

            const id = input.by.map((dimension) => values[dimension]).join("\u0000");
            const group = groups.get(id) ?? { key, usd: 0, tokens: 0, items: 0 };
            group.usd += row.usd;
            group.tokens += row.tokens;
            group.items += 1;
            groups.set(id, group);
            total.usd += row.usd;
            total.tokens += row.tokens;
            total.items += 1;
            all.push(row);
        }
    }

    logger.debug({ files: files.size, items: total.items, unsupported }, "[ai-spend] waste scanned");

    return {
        by: [...input.by],
        groups: [...groups.values()].sort((a, b) => b.usd - a.usd),
        total,
        top: all.sort((a, b) => b.usd - a.usd).slice(0, input.top ?? 10),
        sessions: { scanned: scanned.size, unsupported },
    };
}
