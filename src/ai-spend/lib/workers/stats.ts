import { basename } from "node:path";
import { transcriptStem } from "@genesiscz/utils/providers/session-paths";
import { findCodexRollout } from "@genesiscz/utils/session-changes/codex";
import type { WorkerBackend } from "@genesiscz/utils/worker/capabilities";
import { addTokens, EMPTY_TOKENS, type WorkerAuthMode, type WorkerTokens } from "@genesiscz/utils/worker/cost";
import { DEFAULT_PRICING } from "../pricing";
import { inDayWindow, zonedDay } from "../reports/dates";
import { dedupEvents } from "../reports/load";
import { loadNativeSessionEvents } from "../reports/native";
import type { SpendEvent } from "../reports/types";
import type { PricingTable } from "../types";
import { CLAUDE_COUNTERFACTUAL, priceAsClaude, priceSpendEvents } from "./cost";
import { readWorkerCostRows, type WorkerCostRow } from "./ledger";
import { listWorkerSessions, type WorkerSessionInfo } from "./sessions";

/**
 * Worker spend over time: ai-spend's own transcripts priced request by request (the token and
 * cost numbers), joined with what only the worker stores and the ledger know (backend, name,
 * label, login, turns, duration, tool calls).
 *
 * A session whose transcripts ai-spend cannot find (deleted, or in a home it was never told
 * about) falls back to the cost its turns booked in the ledger, and is counted as such.
 */

export type WorkerStatsDimension = "backend" | "model" | "label" | "day" | "name";

export const WORKER_STATS_DIMENSIONS: readonly WorkerStatsDimension[] = ["backend", "model", "label", "day", "name"];

export interface WorkerStatsTotals {
    sessions: number;
    /** Turns the ledger booked in the window. A session from before the ledger has none until `--backfill`. */
    turns: number;
    /** Priced usage events: one per model request (codex, claude), one per turn (grok, which records only that). */
    requests: number;
    durationMs: number;
    toolCalls: number;
    tokens: WorkerTokens;
    apiEquivalentUsd: number;
    /** Requests with no list price and no recorded cost: not in the sum. */
    unpricedRequests: number;
    billedUsd: number;
    /** Requests whose login or API-key price is unknown, so what they billed is too. */
    unbilledRequests: number;
    claudeOpusUsd: number;
    claudeSonnetUsd: number;
    /** Sessions priced from the ledger because ai-spend found no transcript for them. */
    ledgerOnlySessions: number;
}

export interface WorkerStatsGroup extends WorkerStatsTotals {
    key: Partial<Record<WorkerStatsDimension, string>>;
}

export interface WorkerStatsReport {
    window: { sinceDay?: string; untilDay?: string; timezone: string };
    dimensions: WorkerStatsDimension[];
    groups: WorkerStatsGroup[];
    total: WorkerStatsTotals;
    claudeEquivalent: { opusModel: string; sonnetModel: string; estimate: true };
    notes: string[];
}

export interface WorkerStatsOptions {
    home: string;
    timezone: string;
    sinceDay?: string;
    untilDay?: string;
    dimensions: readonly WorkerStatsDimension[];
    backends?: readonly WorkerBackend[];
    /** Substring of the label. */
    label?: string;
    pricing?: PricingTable;
    /** Seams for tests: the sessions, the ledger and one session's events. */
    sessions?: WorkerSessionInfo[];
    rows?: WorkerCostRow[];
    loadSessionEvents?: (session: WorkerSessionInfo, minMtimeMs: number) => SpendEvent[] | null;
}

function emptyTotals(): WorkerStatsTotals {
    return {
        sessions: 0,
        turns: 0,
        requests: 0,
        durationMs: 0,
        toolCalls: 0,
        tokens: EMPTY_TOKENS,
        apiEquivalentUsd: 0,
        unpricedRequests: 0,
        billedUsd: 0,
        unbilledRequests: 0,
        claudeOpusUsd: 0,
        claudeSonnetUsd: 0,
        ledgerOnlySessions: 0,
    };
}

function sessionKey(backend: WorkerBackend, sessionId: string | null, name: string): string {
    return `${backend}|${sessionId ?? name}`;
}

/**
 * One worker session's transcript events, through ai-spend's own loader. The session's home is
 * handed over as a discovered home, because a worker may run in one ai-spend never walks by
 * default (`--worker-home`, `worker-home-noskills`, a codex `--home`). null when no transcript
 * of the session exists anywhere ai-spend looks.
 */
export function loadWorkerSessionEvents(
    session: Pick<WorkerSessionInfo, "backend" | "sessionId" | "home">,
    options: { home: string; minMtimeMs: number }
): SpendEvent[] | null {
    if (!session.sessionId) {
        return null;
    }

    const homes = session.home ? [{ home: session.home }] : [];
    let id = session.sessionId;

    // ai-spend keys codex usage by the rollout's file name (`rollout-<time>-<thread id>`).
    if (session.backend === "codex") {
        const rollout = findCodexRollout(session.sessionId, session.home ? [session.home] : undefined);

        if (!rollout) {
            return null;
        }

        id = transcriptStem(basename(rollout));
    }

    // The by-name door only: `loadEvents` would fall back to reading EVERY Claude transcript
    // for a session whose file is gone.
    const found = loadNativeSessionEvents(session.backend, {
        home: options.home,
        sessionId: id,
        minMtimeMs: options.minMtimeMs,
        discoveredHomes: homes,
    });

    return found === undefined ? null : dedupEvents(found).filter((event) => event.sessionId === id);
}

function bucket(
    groups: Map<string, WorkerStatsGroup>,
    key: WorkerStatsGroup["key"],
    dims: readonly WorkerStatsDimension[]
) {
    const id = dims.map((dim) => key[dim] ?? "").join("\u0000");
    let group = groups.get(id);

    if (!group) {
        group = { key, ...emptyTotals() };
        groups.set(id, group);
    }

    return group;
}

function keyOf(
    dims: readonly WorkerStatsDimension[],
    values: Record<WorkerStatsDimension, string>
): WorkerStatsGroup["key"] {
    const key: WorkerStatsGroup["key"] = {};

    for (const dim of dims) {
        key[dim] = values[dim];
    }

    return key;
}

function addEvent(group: WorkerStatsTotals, event: SpendEvent, auth: WorkerAuthMode, pricing: PricingTable): void {
    const own = priceSpendEvents([event], pricing);
    group.requests += 1;
    group.tokens = addTokens(group.tokens, {
        input: event.inputTokens,
        cacheRead: event.cacheReadTokens,
        cacheWrite: event.cacheCreationTokens,
        ...(event.cacheCreation1hTokens ? { cacheWrite1h: event.cacheCreation1hTokens } : {}),
        output: event.outputTokens,
        reasoning: event.reasoningOutputTokens ?? 0,
    });

    if (own.usd === null) {
        group.unpricedRequests += 1;
    } else {
        group.apiEquivalentUsd += own.usd;
    }

    if (auth === "unknown" || (auth === "api-key" && own.usd === null)) {
        group.unbilledRequests += 1;
    } else if (auth === "api-key") {
        group.billedUsd += own.usd ?? 0;
    }

    group.claudeOpusUsd += priceAsClaude([event], CLAUDE_COUNTERFACTUAL.opus, pricing) ?? 0;
    group.claudeSonnetUsd += priceAsClaude([event], CLAUDE_COUNTERFACTUAL.sonnet, pricing) ?? 0;
}

function addLedgerCost(group: WorkerStatsTotals, row: WorkerCostRow): void {
    group.requests += 1;
    group.tokens = addTokens(group.tokens, row.tokens ?? EMPTY_TOKENS);

    if (row.cost.apiEquivalentUsd === null) {
        group.unpricedRequests += 1;
    } else {
        group.apiEquivalentUsd += row.cost.apiEquivalentUsd;
    }

    if (row.cost.billedUsd === null) {
        group.unbilledRequests += 1;
    } else {
        group.billedUsd += row.cost.billedUsd;
    }

    group.claudeOpusUsd += row.cost.claudeEquivalent.opusUsd ?? 0;
    group.claudeSonnetUsd += row.cost.claudeEquivalent.sonnetUsd ?? 0;
}

function addTotals(into: WorkerStatsTotals, from: WorkerStatsTotals): void {
    into.sessions += from.sessions;
    into.turns += from.turns;
    into.requests += from.requests;
    into.durationMs += from.durationMs;
    into.toolCalls += from.toolCalls;
    into.tokens = addTokens(into.tokens, from.tokens);
    into.apiEquivalentUsd += from.apiEquivalentUsd;
    into.unpricedRequests += from.unpricedRequests;
    into.billedUsd += from.billedUsd;
    into.unbilledRequests += from.unbilledRequests;
    into.claudeOpusUsd += from.claudeOpusUsd;
    into.claudeSonnetUsd += from.claudeSonnetUsd;
    into.ledgerOnlySessions += from.ledgerOnlySessions;
}

/** Midnight of the day before `sinceDay` in UTC: no transcript last written before it can hold an event of the window. */
function windowMinMtimeMs(sinceDay: string | undefined): number {
    if (!sinceDay) {
        return 0;
    }

    const start = Date.parse(`${sinceDay}T00:00:00.000Z`);
    return Number.isFinite(start) ? start - 24 * 60 * 60 * 1000 : 0;
}

export function buildWorkerStats(options: WorkerStatsOptions): WorkerStatsReport {
    const { timezone, sinceDay, untilDay, dimensions } = options;
    const pricing = options.pricing ?? DEFAULT_PRICING;
    const minMtimeMs = windowMinMtimeMs(sinceDay);
    const labelFilter = options.label?.toLowerCase();
    const inWindow = (ts: string) => inDayWindow(zonedDay(ts, timezone), sinceDay, untilDay);
    const rows = (options.rows ?? readWorkerCostRows()).filter(
        (row) => !options.backends || options.backends.includes(row.backend)
    );
    const rowsBySession = new Map<string, WorkerCostRow[]>();

    for (const row of rows) {
        const key = sessionKey(row.backend, row.sessionId, row.name);
        rowsBySession.set(key, [...(rowsBySession.get(key) ?? []), row]);
    }

    const load =
        options.loadSessionEvents ??
        ((session: WorkerSessionInfo, mtime: number) =>
            loadWorkerSessionEvents(session, { home: options.home, minMtimeMs: mtime }));
    const groups = new Map<string, WorkerStatsGroup>();
    const sessions = [...(options.sessions ?? listWorkerSessions(options.backends))];
    const known = new Set(sessions.map((session) => sessionKey(session.backend, session.sessionId, session.name)));
    const ledgerOnly = new Set<string>();

    for (const [key, booked] of rowsBySession) {
        if (known.has(key)) {
            continue;
        }

        const last = booked.at(-1)!;
        ledgerOnly.add(key);
        sessions.push({
            backend: last.backend,
            name: last.name,
            sessionId: last.sessionId,
            home: null,
            cwd: last.cwd,
            model: last.model,
            effort: last.effort,
            label: null,
            auth: "unknown",
            account: last.account,
            lastActiveAt: null,
        });
    }
    const notes: string[] = [];
    const contributing = new Set<string>();

    for (const session of sessions) {
        const sessionRows = rowsBySession.get(sessionKey(session.backend, session.sessionId, session.name)) ?? [];
        const label = session.label ?? sessionRows.findLast((row) => row.label)?.label ?? "";

        if (labelFilter !== undefined && !label.toLowerCase().includes(labelFilter)) {
            continue;
        }

        // A session idle since before the window cannot have spent in it.
        if (session.lastActiveAt && sinceDay && Date.parse(session.lastActiveAt) < minMtimeMs) {
            continue;
        }

        const authAt = (timestamp: string): WorkerAuthMode => {
            const time = Date.parse(timestamp);
            const matches = sessionRows.filter((row) => {
                const end = Date.parse(row.ts);
                return time <= end && time >= end - (row.durationMs ?? 0);
            });
            // Missing or overlapping turn evidence cannot establish a historical login.
            return matches.length === 1 ? matches[0].auth : "unknown";
        };
        const values = (model: string | null, ts: string): Record<WorkerStatsDimension, string> => ({
            backend: session.backend,
            model: model || session.model || "?",
            label,
            day: zonedDay(ts, timezone),
            name: session.name,
        });
        const touched = new Set<WorkerStatsGroup>();
        const events = ledgerOnly.has(sessionKey(session.backend, session.sessionId, session.name))
            ? null
            : load(session, minMtimeMs);
        const windowRows = sessionRows.filter((row) => inWindow(row.ts));

        if (events === null) {
            for (const row of windowRows) {
                const group = bucket(groups, keyOf(dimensions, values(row.model, row.ts)), dimensions);
                addLedgerCost(group, row);
                touched.add(group);
            }

            if (windowRows.length > 0) {
                notes.push(`${session.backend} ${session.name}: no transcript found, priced from its ledger rows`);
                for (const group of touched) {
                    group.ledgerOnlySessions += 1;
                }
            }
        } else {
            for (const event of events) {
                if (!inWindow(event.timestamp)) {
                    continue;
                }

                const group = bucket(groups, keyOf(dimensions, values(event.model, event.timestamp)), dimensions);
                addEvent(group, event, authAt(event.timestamp), pricing);
                touched.add(group);
            }
        }

        for (const row of windowRows) {
            const group = bucket(groups, keyOf(dimensions, values(row.model, row.ts)), dimensions);
            group.turns += row.turn === null ? 0 : 1;
            group.durationMs += row.durationMs ?? 0;
            group.toolCalls += row.toolCalls ?? 0;
            touched.add(group);
        }

        for (const group of touched) {
            group.sessions += 1;
        }

        if (touched.size > 0) {
            contributing.add(sessionKey(session.backend, session.sessionId, session.name));
        }
    }

    const sorted = [...groups.values()]
        .filter((group) => group.requests > 0 || group.turns > 0)
        .sort(
            (a, b) =>
                b.apiEquivalentUsd - a.apiEquivalentUsd ||
                dimensions
                    .map((dim) => a.key[dim] ?? "")
                    .join(" ")
                    .localeCompare(dimensions.map((dim) => b.key[dim] ?? "").join(" "))
        );
    const total = emptyTotals();

    for (const group of sorted) {
        addTotals(total, group);
    }

    // A session split across several groups (by day or model) is one session, not several.
    total.sessions = contributing.size;

    return {
        window: { ...(sinceDay ? { sinceDay } : {}), ...(untilDay ? { untilDay } : {}), timezone },
        dimensions: [...dimensions],
        groups: sorted,
        total,
        claudeEquivalent: {
            opusModel: CLAUDE_COUNTERFACTUAL.opus,
            sonnetModel: CLAUDE_COUNTERFACTUAL.sonnet,
            estimate: true,
        },
        notes,
    };
}
