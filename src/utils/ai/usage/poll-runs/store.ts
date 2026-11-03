import type { Database } from "bun:sqlite";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { DAEMON_ALIVE_MS } from "@genesiscz/utils/ai/usage-poll/daemon-heartbeat";

/**
 * Poll coverage (design 2026-11-01, step U5): what the poller knew about each account, stored as run lengths in
 * `usage_poll_runs`. The daemon tick writes one round; a round with the same outcome as the account's last run, close
 * enough in time, only moves that run's end. The table is created by `USAGE_LIMITS_MIGRATIONS`.
 */

/** What one poll of one account came to. A span with no run is `unmeasured`: nobody polled. */
export type PollOutcome = "ok" | "stale" | "error" | "blocked" | "backoff" | "needs-login";

export const POLL_OUTCOMES: readonly PollOutcome[] = ["ok", "stale", "error", "blocked", "backoff", "needs-login"];

function isPollOutcome(value: string): value is PollOutcome {
    return (POLL_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The outcome of one snapshot, most specific first: no credential, held by the poll gate, refused by the
 * organization, failed, a replay of an older reading, a fresh reading.
 */
export function pollOutcomeOf(snapshot: AccountUsageSnapshot): PollOutcome {
    if (snapshot.needsLogin) {
        return "needs-login";
    }

    if (snapshot.blocked) {
        return "backoff";
    }

    if (snapshot.auth?.orgBlocked) {
        return "blocked";
    }

    if (snapshot.error !== undefined) {
        return "error";
    }

    if (snapshot.stale) {
        return "stale";
    }

    return "ok";
}

export interface PollRun {
    id: number;
    provider: string;
    accountId: string;
    accountName: string;
    /** ISO UTC. */
    from: string;
    /** ISO UTC: the last poll this run covers. */
    to: string;
    outcome: PollOutcome;
    /** How the reading was made (`endpoint`, `headers`, `app-server`, ...), from the provider's `readingSource`. */
    source: string | null;
    /** When the poll gate lets the account be polled again, while it holds it. */
    gateUntil: string | null;
    /** The error, stale or gate reason of the latest poll in the run. */
    reason: string | null;
    polls: number;
}

interface RunSqlRow {
    id: number;
    provider: string;
    account_id: string;
    account_name: string;
    from_ts: string;
    to_ts: string;
    outcome: string;
    source: string | null;
    gate_until: string | null;
    reason: string | null;
    polls: number;
}

interface LastRoundRow {
    last: string | null;
}

export interface RoundEntry {
    snapshot: AccountUsageSnapshot;
    source: string | null;
}

/**
 * Two polls further apart than this are not one run: the span between them had no poll. The daemon's own liveness
 * bound (two ticks plus the fetch slack), so a late tick still continues its run.
 */
export const RUN_CONTINUES_MS = DAEMON_ALIVE_MS;

function reasonOf(snapshot: AccountUsageSnapshot): string | null {
    return snapshot.error ?? snapshot.stale?.reason ?? snapshot.needsLogin?.remedy ?? null;
}

function isMissingTable(err: unknown): boolean {
    return err instanceof Error && /no such table/.test(err.message);
}

function mapRun(row: RunSqlRow): PollRun {
    return {
        id: row.id,
        provider: row.provider,
        accountId: row.account_id,
        accountName: row.account_name,
        from: row.from_ts,
        to: row.to_ts,
        // An outcome this build does not know came from a newer build: shown as a failure, never as a reading.
        outcome: isPollOutcome(row.outcome) ? row.outcome : "error",
        source: row.source,
        gateUntil: row.gate_until,
        reason: row.reason,
        polls: row.polls,
    };
}

export class PollRunsStore {
    constructor(private readonly db: Database) {}

    /**
     * Records one poll round. A round entry extends the account's latest run when the outcome and the source are the
     * same and the run ended at most `RUN_CONTINUES_MS` ago; otherwise it starts a run. A run that follows its
     * predecessor without a gap starts where that one ended, so the strip has no false hole between them.
     */
    recordRound(entries: readonly RoundEntry[], now: Date): { extended: number; started: number } {
        const at = now.toISOString();
        let extended = 0;
        let started = 0;
        const write = this.db.transaction(() => {
            for (const { snapshot, source } of entries) {
                const outcome = pollOutcomeOf(snapshot);
                const latest = this.latestRun(snapshot.provider, snapshot.accountId);
                const contiguous =
                    latest !== null && now.getTime() - Date.parse(latest.to) <= RUN_CONTINUES_MS && latest.to <= at;
                const gateUntil = snapshot.blocked?.until ?? null;
                const reason = reasonOf(snapshot);

                if (contiguous && latest.outcome === outcome && latest.source === source) {
                    this.db
                        .prepare(
                            `UPDATE usage_poll_runs
                             SET to_ts = ?, polls = polls + 1, gate_until = ?, reason = ?, account_name = ?
                             WHERE id = ?`
                        )
                        .run(at, gateUntil, reason, snapshot.accountName, latest.id);
                    extended++;
                    continue;
                }

                this.db
                    .prepare(
                        `INSERT INTO usage_poll_runs
                            (provider, account_id, account_name, from_ts, to_ts, outcome, source, gate_until, reason)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    )
                    .run(
                        snapshot.provider,
                        snapshot.accountId,
                        snapshot.accountName,
                        contiguous ? latest.to : at,
                        at,
                        outcome,
                        source,
                        gateUntil,
                        reason
                    );
                started++;
            }
        });

        write.immediate();
        return { extended, started };
    }

    latestRun(provider: string, accountId: string): PollRun | null {
        const row = this.db
            .prepare(
                `SELECT id, provider, account_id, account_name, from_ts, to_ts, outcome, source, gate_until, reason, polls
                 FROM usage_poll_runs
                 WHERE provider = ? AND account_id = ?
                 ORDER BY to_ts DESC, id DESC
                 LIMIT 1`
            )
            .get(provider, accountId) as RunSqlRow | null;

        return row ? mapRun(row) : null;
    }

    /** The newest end of any run: when the poller last recorded a round. Null before the first. */
    lastRoundAt(): string | null {
        try {
            const row = this.db.prepare("SELECT MAX(to_ts) AS last FROM usage_poll_runs").get() as LastRoundRow | null;
            return row?.last ?? null;
        } catch (err) {
            if (isMissingTable(err)) {
                return null;
            }

            throw err;
        }
    }

    /** Runs that overlap `[from, to]`, oldest first. A store without the table answers no runs. */
    runsBetween(query: { from: Date; to: Date; providers?: readonly string[] }): PollRun[] {
        const params: string[] = [query.to.toISOString(), query.from.toISOString()];
        let providerFilter = "";

        if (query.providers && query.providers.length > 0) {
            providerFilter = ` AND provider IN (${query.providers.map(() => "?").join(", ")})`;
            params.push(...query.providers);
        }

        try {
            const rows = this.db
                .prepare(
                    `SELECT id, provider, account_id, account_name, from_ts, to_ts, outcome, source, gate_until, reason, polls
                     FROM usage_poll_runs
                     WHERE from_ts <= ? AND to_ts >= ?${providerFilter}
                     ORDER BY from_ts ASC, id ASC`
                )
                .all(...params) as RunSqlRow[];

            return rows.map(mapRun);
        } catch (err) {
            if (isMissingTable(err)) {
                return [];
            }

            throw err;
        }
    }
}
