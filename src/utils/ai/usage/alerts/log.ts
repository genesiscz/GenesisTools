import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import {
    ALERT_CHANNEL_IDS,
    type AlertCandidate,
    type AlertChannelId,
    type AlertLevel,
    isAlertRuleId,
    type StoredAlert,
} from "./types";

/**
 * The `usage_alerts` store: every alert the engine fired, the engine's dedupe memory, and the feed the popover and
 * `tools ai usage alerts` read. The table comes from `USAGE_LIMITS_MIGRATIONS`; this class only reads and writes rows,
 * so a read-only connection serves the listing verbs.
 */

interface AlertSqlRow {
    id: number;
    rule: string;
    provider: string | null;
    account_id: string | null;
    account_name: string | null;
    window_kind: string | null;
    window_key: string | null;
    fired_at: string;
    dedupe_key: string;
    cycle: string | null;
    severity: number;
    level: string;
    title: string;
    message: string;
    payload: string | null;
    channels: string | null;
    ack_at: string | null;
}

const COLUMNS =
    "id, rule, provider, account_id, account_name, window_kind, window_key, fired_at, dedupe_key, cycle, severity, level, title, message, payload, channels, ack_at";

const LEVELS: readonly AlertLevel[] = ["info", "warning", "critical"];

export interface AlertListQuery {
    from: Date;
    to: Date;
    rules?: readonly string[];
    providers?: readonly string[];
    /** Account ids or names. */
    accounts?: readonly string[];
    unackedOnly?: boolean;
    limit?: number;
}

function isMissingTable(err: unknown): boolean {
    return err instanceof Error && /no such table/.test(err.message);
}

function parsePayload(text: string | null): Record<string, unknown> | undefined {
    if (!text) {
        return undefined;
    }

    const parsed: unknown = SafeJSON.parse(text, { strict: true });
    return isObject(parsed) ? parsed : undefined;
}

function parseChannels(text: string | null): AlertChannelId[] {
    if (!text) {
        return [];
    }

    const parsed: unknown = SafeJSON.parse(text, { strict: true });

    if (!Array.isArray(parsed)) {
        return [];
    }

    return ALERT_CHANNEL_IDS.filter((id) => parsed.includes(id));
}

function mapRow(row: AlertSqlRow): StoredAlert | null {
    // A rule this build does not know was written by a newer build; it is skipped, never mislabelled.
    if (!isAlertRuleId(row.rule)) {
        return null;
    }

    const payload = parsePayload(row.payload);

    return {
        id: row.id,
        rule: row.rule,
        provider: row.provider,
        accountId: row.account_id,
        accountName: row.account_name,
        windowKind: row.window_kind,
        windowKey: row.window_key,
        firedAt: row.fired_at,
        dedupeKey: row.dedupe_key,
        cycle: row.cycle,
        severity: row.severity,
        level: LEVELS.find((level) => level === row.level) ?? "warning",
        title: row.title,
        message: row.message,
        ...(payload === undefined ? {} : { payload }),
        channels: parseChannels(row.channels),
        ackAt: row.ack_at,
    };
}

export class UsageAlertsStore {
    constructor(private readonly db: Database) {}

    insert(
        candidate: AlertCandidate,
        options: { firedAt: Date; channels: readonly AlertChannelId[]; ackAt?: Date }
    ): StoredAlert {
        const firedAt = options.firedAt.toISOString();
        const ackAt = options.ackAt?.toISOString() ?? null;
        const result = this.db
            .prepare(
                `INSERT INTO usage_alerts
                    (rule, provider, account_id, account_name, window_kind, window_key, fired_at, dedupe_key, cycle,
                     severity, level, title, message, payload, channels, ack_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                candidate.rule,
                candidate.provider,
                candidate.accountId,
                candidate.accountName,
                candidate.windowKind,
                candidate.windowKey,
                firedAt,
                candidate.dedupeKey,
                candidate.cycle,
                candidate.severity,
                candidate.level,
                candidate.title,
                candidate.message,
                candidate.payload === undefined ? null : SafeJSON.stringify(candidate.payload),
                SafeJSON.stringify([...options.channels]),
                ackAt
            );

        return {
            ...candidate,
            id: Number(result.lastInsertRowid),
            firedAt,
            channels: [...options.channels],
            ackAt,
        };
    }

    /** The last alert with this dedupe key, or null. A store without the table has none. */
    latestByDedupe(dedupeKey: string): StoredAlert | null {
        try {
            const row = this.db
                .prepare(
                    `SELECT ${COLUMNS} FROM usage_alerts WHERE dedupe_key = ? ORDER BY fired_at DESC, id DESC LIMIT 1`
                )
                .get(dedupeKey) as AlertSqlRow | null;

            return row ? mapRow(row) : null;
        } catch (err) {
            if (isMissingTable(err)) {
                return null;
            }

            throw err;
        }
    }

    /** Whether any alert of `rule` was ever recorded (the legacy tracker seed runs only before the first). */
    hasRule(rule: string): boolean {
        const row = this.db.prepare("SELECT 1 AS found FROM usage_alerts WHERE rule = ? LIMIT 1").get(rule);
        return row !== null;
    }

    /** Alerts fired in the window, newest first. */
    list(query: AlertListQuery): StoredAlert[] {
        const params: string[] = [query.from.toISOString(), query.to.toISOString()];
        let filters = "";

        for (const [column, values] of [
            ["rule", query.rules],
            ["provider", query.providers],
        ] as const) {
            if (values && values.length > 0) {
                filters += ` AND ${column} IN (${values.map(() => "?").join(", ")})`;
                params.push(...values);
            }
        }

        if (query.accounts && query.accounts.length > 0) {
            const marks = query.accounts.map(() => "?").join(", ");
            filters += ` AND (account_id IN (${marks}) OR account_name IN (${marks}))`;
            params.push(...query.accounts, ...query.accounts);
        }

        if (query.unackedOnly) {
            filters += " AND ack_at IS NULL";
        }

        const limit = query.limit === undefined ? "" : ` LIMIT ${Math.max(1, Math.floor(query.limit))}`;

        try {
            const rows = this.db
                .prepare(
                    `SELECT ${COLUMNS} FROM usage_alerts
                     WHERE fired_at >= ? AND fired_at <= ?${filters}
                     ORDER BY fired_at DESC, id DESC${limit}`
                )
                .all(...params) as AlertSqlRow[];

            return rows.flatMap((row) => {
                const mapped = mapRow(row);
                return mapped ? [mapped] : [];
            });
        } catch (err) {
            if (isMissingTable(err)) {
                return [];
            }

            throw err;
        }
    }

    /** Marks alerts acknowledged; `ids` omitted acknowledges every open one. Returns how many changed. */
    ack(options: { ids?: readonly number[]; at: Date }): number {
        const at = options.at.toISOString();

        if (options.ids === undefined) {
            return this.db.prepare("UPDATE usage_alerts SET ack_at = ? WHERE ack_at IS NULL").run(at).changes;
        }

        if (options.ids.length === 0) {
            return 0;
        }

        const marks = options.ids.map(() => "?").join(", ");
        return this.db
            .prepare(`UPDATE usage_alerts SET ack_at = ? WHERE ack_at IS NULL AND id IN (${marks})`)
            .run(at, ...options.ids).changes;
    }
}
