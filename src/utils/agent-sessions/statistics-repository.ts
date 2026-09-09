import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import type { TokenUsage } from "./cache-types";
import { HistoryRepository, type HistorySourceSnapshot } from "./repository";
import type { HistoryStatisticsRead } from "./types";

type Contribution = HistoryStatisticsRead["days"][number];

/** `complete` = every expected source contributed; `partial` = some did; `refused` = none written. */
export type HistoryPublishOutcome = "complete" | "partial" | "refused";

interface ContributionRow {
    source_key: string;
    date: string;
    project: string;
    conversations: number;
    messages: number;
    subagent_sessions: number;
    tool_counts: string;
    hourly_activity: string;
    token_usage: string | null;
    model_counts: string;
    branch_counts: string;
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
    for (const [key, value] of Object.entries(source)) {
        target[key] = (target[key] ?? 0) + value;
    }
}

function decodeContribution(row: ContributionRow): Contribution {
    return {
        date: row.date,
        project: row.project,
        conversations: row.conversations,
        messages: row.messages,
        subagentSessions: row.subagent_sessions,
        toolCounts: SafeJSON.parse(row.tool_counts, { strict: true }) as Record<string, number>,
        hourlyActivity: SafeJSON.parse(row.hourly_activity, { strict: true }) as Record<string, number>,
        tokenUsage: row.token_usage === null ? null : (SafeJSON.parse(row.token_usage, { strict: true }) as TokenUsage),
        modelCounts: SafeJSON.parse(row.model_counts, { strict: true }) as Record<string, number>,
        branchCounts: SafeJSON.parse(row.branch_counts, { strict: true }) as Record<string, number>,
    };
}

function rollupContributions(rows: Contribution[]): Contribution[] {
    const rollups = new Map<string, Contribution>();

    for (const row of rows) {
        for (const project of new Set([row.project, "__all__"])) {
            const key = SafeJSON.stringify([row.date, project]);
            let target = rollups.get(key);

            if (!target) {
                target = {
                    date: row.date,
                    project,
                    conversations: 0,
                    messages: 0,
                    subagentSessions: 0,
                    toolCounts: {},
                    hourlyActivity: {},
                    modelCounts: {},
                    branchCounts: {},
                    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
                };
                rollups.set(key, target);
            }

            target.conversations += row.conversations;
            target.messages += row.messages;
            target.subagentSessions += row.subagentSessions;
            addCounts(target.toolCounts, row.toolCounts);
            addCounts(target.hourlyActivity, row.hourlyActivity);
            addCounts(target.modelCounts, row.modelCounts);
            addCounts(target.branchCounts, row.branchCounts);

            if (target.tokenUsage && row.tokenUsage) {
                for (const key of ["inputTokens", "outputTokens", "cacheCreateTokens", "cacheReadTokens"] as const) {
                    target.tokenUsage[key] += row.tokenUsage[key];
                }
            } else {
                target.tokenUsage = null;
            }
        }
    }

    return [...rollups.values()];
}

/** Aggregate-only source replacements; published legacy totals survive incomplete backfills. */
export class HistoryStatisticsRepository {
    private readonly metadata: HistoryRepository;

    constructor(private readonly db: Database) {
        this.metadata = new HistoryRepository(db);
    }

    replace(options: {
        expected: HistorySourceSnapshot;
        revision: string;
        inputsRevision?: string;
        parserVersion: string;
        statistics: HistoryStatisticsRead;
        sourceMtime: number;
        verifyRevision: () => boolean;
    }): boolean {
        if (!options.statistics.complete) {
            return false;
        }

        return this.db
            .transaction(() => {
                const current = this.metadata.getSource(options.expected.sourceKey);

                if (
                    !current ||
                    current.providerId !== options.expected.providerId ||
                    current.filePath !== options.expected.filePath ||
                    current.generation !== options.expected.generation ||
                    current.metadataRevision !== options.revision ||
                    current.metadataRevision !== options.expected.metadataRevision ||
                    !options.verifyRevision()
                ) {
                    return false;
                }

                const { summary, days } = options.statistics;
                this.db
                    .query("DELETE FROM file_daily_stats WHERE provider=? AND source_key=?")
                    .run(current.providerId, current.sourceKey);
                const insert = this.db.prepare(`INSERT INTO file_daily_stats (
                source_key, provider, date, project, conversations, messages, subagent_sessions,
                tool_counts, hourly_activity, token_usage, model_counts, branch_counts
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

                for (const day of days) {
                    insert.run(
                        current.sourceKey,
                        current.providerId,
                        day.date,
                        day.project,
                        day.conversations,
                        day.messages,
                        day.subagentSessions,
                        SafeJSON.stringify(day.toolCounts),
                        SafeJSON.stringify(day.hourlyActivity),
                        day.tokenUsage === null ? null : SafeJSON.stringify(day.tokenUsage),
                        SafeJSON.stringify(day.modelCounts),
                        SafeJSON.stringify(day.branchCounts)
                    );
                }

                this.db
                    .query(`UPDATE file_index SET mtime=?, message_count=?, first_date=?, last_date=?,
                project=(SELECT project FROM session_metadata WHERE source_key=?),
                is_subagent=(SELECT is_subagent FROM session_metadata WHERE source_key=?),
                last_indexed=?, stats_revision=?, stats_inputs_revision=?, stats_parser_version=?, statistics_status='complete'
                WHERE provider=? AND source_key=?`)
                    .run(
                        options.sourceMtime,
                        summary.messages,
                        summary.firstDate,
                        summary.lastDate,
                        current.sourceKey,
                        current.sourceKey,
                        new Date().toISOString(),
                        options.revision,
                        options.inputsRevision ?? options.revision,
                        options.parserVersion,
                        current.providerId,
                        current.sourceKey
                    );
                this.markStale(current.providerId);
                return true;
            })
            .immediate();
    }

    markStale(providerId: string): void {
        this.db.query("UPDATE daily_stats SET coverage='stale' WHERE provider=?").run(providerId);
        this.db.query("UPDATE totals_cache SET coverage='stale' WHERE provider=?").run(providerId);
    }

    coverage(providerId: string): { sources: number; complete: number } {
        return this.db
            .query<{ sources: number; complete: number }, [string]>(`
            SELECT count(*) AS sources, coalesce(sum(statistics_status='complete' AND stats_revision=metadata_revision),0) AS complete
            FROM file_index WHERE provider=?
        `)
            .get(providerId)!;
    }

    /** A completed unfiltered discovery is required; zero known rows alone cannot prove an empty provider. */
    /**
     * Publishing used to be all or nothing: one source whose metadata revision had moved refused
     * the rollup for every other source. On this machine that meant a cold build ended with
     * `file_daily_stats` at 12,918 rows but `daily_stats` and `totals_cache` at zero, and the
     * dashboard read "0 conversations, 0 messages" — because 6 of 12,058 sources were mid-write.
     * Any live session keeps at least one source moving, so the condition never cleared.
     *
     * Discovery still has to be complete: without the full source set a rollup could silently
     * drop a whole root. But once it is, the sources that DID complete are published and the
     * rows say `partial` so nothing mistakes them for full coverage.
     */
    publish(options: {
        providerId: string;
        discoveryComplete: boolean;
        expectedSourceKeys: string[];
    }): HistoryPublishOutcome {
        if (!options.discoveryComplete) {
            return "refused";
        }

        return this.db
            .transaction(() => {
                const current = this.db
                    .query<
                        {
                            source_key: string;
                            statistics_status: string;
                            stats_revision: string | null;
                            metadata_revision: string | null;
                        },
                        [string]
                    >(
                        "SELECT source_key,statistics_status,stats_revision,metadata_revision FROM file_index WHERE provider=?"
                    )
                    .all(options.providerId);
                const expected = new Set(options.expectedSourceKeys);
                const publishable = new Set(
                    current
                        .filter(
                            (source) =>
                                expected.has(source.source_key) &&
                                source.statistics_status === "complete" &&
                                source.stats_revision !== null &&
                                source.stats_revision === source.metadata_revision
                        )
                        .map((source) => source.source_key)
                );
                const full = current.length === expected.size && publishable.size === expected.size;

                if (publishable.size === 0) {
                    return "refused";
                }

                const coverage = full ? "complete" : "partial";
                const rows = this.db
                    .query<ContributionRow, [string]>("SELECT * FROM file_daily_stats WHERE provider=?")
                    .all(options.providerId)
                    .filter((row) => publishable.has(row.source_key));
                const rollups = rollupContributions(rows.map(decodeContribution));
                const keys = rollups.map((day) => SafeJSON.stringify([day.date, day.project]));
                this.db
                    .query(
                        "DELETE FROM daily_stats WHERE provider=? AND json_array(date,project) NOT IN (SELECT value FROM json_each(?))"
                    )
                    .run(options.providerId, SafeJSON.stringify(keys));
                const insert =
                    this.db.prepare(`INSERT INTO daily_stats (provider,date,project,conversations,messages,subagent_sessions,
                tool_counts,hourly_activity,token_usage,model_counts,branch_counts,computed_at,coverage)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,date,project) DO UPDATE SET
                conversations=excluded.conversations,messages=excluded.messages,subagent_sessions=excluded.subagent_sessions,
                tool_counts=excluded.tool_counts,hourly_activity=excluded.hourly_activity,token_usage=excluded.token_usage,
                model_counts=excluded.model_counts,branch_counts=excluded.branch_counts,computed_at=excluded.computed_at,coverage=excluded.coverage`);
                const now = new Date().toISOString();

                for (const day of rollups) {
                    insert.run(
                        options.providerId,
                        day.date,
                        day.project,
                        day.conversations,
                        day.messages,
                        day.subagentSessions,
                        SafeJSON.stringify(day.toolCounts),
                        SafeJSON.stringify(day.hourlyActivity),
                        day.tokenUsage === null ? null : SafeJSON.stringify(day.tokenUsage),
                        SafeJSON.stringify(day.modelCounts),
                        SafeJSON.stringify(day.branchCounts),
                        now,
                        coverage
                    );
                }

                const { projects } = this.db
                    .query<{ projects: number }, [string]>(
                        "SELECT count(DISTINCT project) AS projects FROM file_index WHERE provider=?"
                    )
                    .get(options.providerId)!;
                // Quick totals describe the same dated observations as the published daily series.
                // Undated original records remain counted separately in file_index/status.
                const totals = rollups
                    .filter((day) => day.project === "__all__")
                    .reduce(
                        (total, day) => ({
                            conversations: total.conversations + day.conversations,
                            messages: total.messages + day.messages,
                            subagents: total.subagents + day.subagentSessions,
                            projects,
                        }),
                        { conversations: 0, messages: 0, subagents: 0, projects }
                    );
                this.db
                    .query(`INSERT INTO totals_cache (provider,scope,id,total_conversations,total_messages,total_subagents,project_count,last_updated,coverage)
                VALUES (?,'__all__',1,?,?,?,?,?,?) ON CONFLICT(provider,scope) DO UPDATE SET
                total_conversations=excluded.total_conversations,total_messages=excluded.total_messages,total_subagents=excluded.total_subagents,
                project_count=excluded.project_count,last_updated=excluded.last_updated,coverage=excluded.coverage`)
                    .run(
                        options.providerId,
                        totals.conversations,
                        totals.messages,
                        totals.subagents,
                        totals.projects,
                        now,
                        coverage
                    );
                return coverage;
            })
            .immediate();
    }
}
