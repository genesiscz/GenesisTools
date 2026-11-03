import type { Database } from "bun:sqlite";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import {
    type AccountKey,
    refuseHarness,
    resolveProviderList,
    resolveWindow,
    splitList,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
    type WindowFlags,
} from "@genesiscz/utils/ai/usage/contract";
import {
    countByKind,
    isUsageEventKind,
    USAGE_EVENT_KINDS,
    type UsageEventKind,
    type UsageEventRow,
    UsageEventsStore,
} from "@genesiscz/utils/ai/usage/events/store";
import { logger } from "@genesiscz/utils/logger";

/** `usage.events@1`. */
export const USAGE_EVENTS_SCHEMA = { verb: "events", version: 1 } as const;

export interface EventsOptions extends WindowFlags {
    provider?: string[] | boolean;
    account?: string[];
    kind?: string[] | boolean;
    limit?: string;
    json?: boolean;
    harness?: string[] | boolean;
}

export interface EventsData {
    events: UsageEventRow[];
    /** Per kind; a daily probe row counts its `count`. */
    counts: Partial<Record<UsageEventKind, number>>;
}

function resolveKinds(raw: string[] | boolean | undefined): UsageEventKind[] | undefined {
    const enumFlag = { flag: "--kind", values: USAGE_EVENT_KINDS };

    if (raw === true) {
        throw new UsageQueryError("bad-value", `--kind needs a value: ${USAGE_EVENT_KINDS.join(" | ")}.`, { enumFlag });
    }

    const list = splitList(raw);

    if (list.length === 0) {
        return undefined;
    }

    const unknown = list.find((value) => !isUsageEventKind(value));

    if (unknown !== undefined) {
        throw new UsageQueryError("bad-value", `--kind "${unknown}" is not one of ${USAGE_EVENT_KINDS.join(" | ")}.`, {
            given: unknown,
            enumFlag,
        });
    }

    return list.filter(isUsageEventKind);
}

function resolveLimit(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value < 1) {
        throw new UsageQueryError("bad-value", `--limit "${raw}" is not a positive whole number.`, { given: raw });
    }

    return value;
}

function keysOf(rows: readonly UsageEventRow[]): AccountKey[] {
    const keys = new Map<string, AccountKey>();

    for (const row of rows) {
        const name = row.accountName ?? row.accountId;

        if (name === null) {
            continue;
        }

        keys.set(`${row.provider}\u0000${name}`, {
            provider: row.provider,
            accountId: row.accountId ?? name,
            accountName: name,
        });
    }

    return [...keys.values()];
}

/**
 * `tools ai usage events` (design 2026-11-01, step U6): the usage events of the window, newest first. `--account`
 * matches an account id or name exactly: an event may name a proxy account the AI config does not know, so the
 * config's selector would refuse names this table holds. A diagnostic: it reads through a read-only connection.
 */
export async function queryEvents(
    opts: EventsOptions,
    deps: { open?: () => Database | undefined; now?: Date } = {}
): Promise<UsageEnvelope<EventsData>> {
    refuseHarness(opts.harness);

    const now = deps.now ?? new Date();
    const window = resolveWindow(opts, { now, defaultSince: "24h" });
    const providers = resolveProviderList(opts.provider);
    const kinds = resolveKinds(opts.kind);
    const limit = resolveLimit(opts.limit);
    const accounts = splitList(opts.account);
    const db = (deps.open ?? (() => openHistoryReadOnly()))();
    const warnings: UsageWarning[] = [];
    let events: UsageEventRow[] = [];

    try {
        if (db) {
            events = new UsageEventsStore(db).list({
                from: window.from,
                to: window.to,
                ...(providers === undefined ? {} : { providers }),
                ...(accounts.length === 0 ? {} : { accounts }),
                ...(kinds === undefined ? {} : { kinds }),
                ...(limit === undefined ? {} : { limit }),
            });
        } else {
            warnings.push({ code: "no-store", message: "No usage store exists here yet, so there are no events." });
        }
    } finally {
        db?.close();
    }

    logger.debug({ window: window.label, events: events.length, kinds, providers }, "[ai-usage] usage events");

    return usageEnvelope({
        ...USAGE_EVENTS_SCHEMA,
        now,
        window,
        accounts: keysOf(events),
        data: { events, counts: countByKind(events) },
        warnings,
    });
}
