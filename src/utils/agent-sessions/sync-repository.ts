import type { Database } from "bun:sqlite";
import { sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { HistoryRepository, type HistorySourceSnapshot } from "./repository";
import type { NativeIndexStatus, NativeSourceIssue } from "./types";

/** Root generations and source lifecycle share the canonical connection and metadata repository. */
export class HistorySyncRepository {
    readonly metadata: HistoryRepository;

    constructor(private readonly db: Database) {
        this.metadata = new HistoryRepository(db);
    }

    transaction<T>(operation: () => T): T {
        return this.db.transaction(operation).immediate();
    }

    begin(options: { providerId: string; roots: string[] }): number {
        return this.transaction(() => {
            const key = SafeJSON.stringify(["history", options.providerId, "generation"]);
            const previous = this.db
                .query<{ value: string }, [string]>("SELECT value FROM cache_meta WHERE key=?")
                .get(key);
            const generation = Number(previous?.value ?? 0) + 1;

            if (!Number.isSafeInteger(generation)) {
                throw new Error("Invalid history discovery generation");
            }

            this.db
                .query(
                    "INSERT INTO cache_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                )
                .run(key, String(generation));

            for (const root of options.roots) {
                this.db
                    .query(`INSERT INTO history_roots(provider,root,generation) VALUES (?,?,?)
                    ON CONFLICT(provider,root) DO UPDATE SET generation=excluded.generation`)
                    .run(options.providerId, root, generation);
                // `sep`, not "/": this is the shared cross-platform package, and a literal slash
                // leaves every Windows row's root NULL forever.
                const prefix = `${root}${sep}`;
                this.db
                    .query("UPDATE file_index SET root=? WHERE provider=? AND root IS NULL AND substr(file_path,1,?)=?")
                    .run(root, options.providerId, prefix.length, prefix);
            }

            return generation;
        });
    }

    sources(providerId: string): HistorySourceSnapshot[] {
        return this.metadata.listSources(providerId);
    }

    observedRoots(providerId: string): Set<string> {
        return new Set(
            this.db
                .query<{ root: string }, [string]>(
                    "SELECT root FROM history_roots WHERE provider=? AND completed_at IS NOT NULL"
                )
                .all(providerId)
                .map((row) => row.root)
        );
    }

    ownsRoot(options: { providerId: string; root: string; generation: number }): boolean {
        return (
            this.db
                .query<{ generation: number }, [string, string]>(
                    "SELECT generation FROM history_roots WHERE provider=? AND root=?"
                )
                .get(options.providerId, options.root)?.generation === options.generation
        );
    }

    remove(source: HistorySourceSnapshot): void {
        this.db
            .query(`UPDATE daily_stats SET coverage='stale' WHERE provider=? AND (
            date IN (SELECT date FROM file_daily_stats WHERE source_key=?) OR
            date BETWEEN (SELECT first_date FROM file_index WHERE source_key=?) AND (SELECT last_date FROM file_index WHERE source_key=?)
        )`)
            .run(source.providerId, source.sourceKey, source.sourceKey, source.sourceKey);
        this.db.query("UPDATE totals_cache SET coverage='stale' WHERE provider=?").run(source.providerId);
        this.db
            .query("DELETE FROM file_daily_stats WHERE provider=? AND source_key=?")
            .run(source.providerId, source.sourceKey);
        this.db
            .query("DELETE FROM session_metadata WHERE provider=? AND source_key=?")
            .run(source.providerId, source.sourceKey);
        this.db
            .query("DELETE FROM file_index WHERE provider=? AND source_key=?")
            .run(source.providerId, source.sourceKey);
    }

    finish(options: { providerId: string; roots: string[]; generation: number; issues: NativeSourceIssue[] }): void {
        const grouped = new Map<string, { path: string; message: string; occurrences: number }>();

        for (const issue of options.issues) {
            const group = grouped.get(issue.path);

            if (group) {
                group.occurrences++;
            } else {
                grouped.set(issue.path, { path: issue.path, message: issue.message.slice(0, 300), occurrences: 1 });
            }
        }

        this.transaction(() => {
            for (const root of options.roots) {
                this.db
                    .query("UPDATE history_roots SET completed_at=? WHERE provider=? AND root=? AND generation=?")
                    .run(new Date().toISOString(), options.providerId, root, options.generation);
            }

            // A later sync's issues must not be overwritten by an older discovery.
            const key = SafeJSON.stringify(["history", options.providerId, "generation"]);
            const generation = this.db
                .query<{ value: string }, [string]>("SELECT value FROM cache_meta WHERE key=?")
                .get(key);

            if (generation?.value !== String(options.generation)) {
                return;
            }

            this.db.query("DELETE FROM history_source_issues WHERE provider=?").run(options.providerId);

            for (const issue of grouped.values()) {
                this.db
                    .query(
                        "INSERT INTO history_source_issues(provider,path,code,message,occurrences) VALUES (?,?,'source',?,?)"
                    )
                    .run(options.providerId, issue.path, issue.message, issue.occurrences);
            }
        });
    }

    status(providerId: string): NativeIndexStatus {
        const sessions = this.db
            .query<{ count: number }, [string]>("SELECT count(*) AS count FROM session_metadata WHERE provider=?")
            .get(providerId)!.count;
        const sources = this.db
            .query<{ count: number; known: number; messages: number }, [string]>(`
            SELECT count(*) AS count, coalesce(sum(
                (statistics_status='legacy' AND metadata_revision IS NULL) OR
                (statistics_status='complete' AND stats_revision=metadata_revision)
            ),0) AS known,
                coalesce(sum(message_count),0) AS messages FROM file_index WHERE provider=?
        `)
            .get(providerId)!;
        return {
            initialized: true,
            sessions,
            sources: sources.count,
            messages: sources.known === sources.count ? sources.messages : null,
            issues: this.db
                .query<NativeSourceIssue, [string]>(
                    "SELECT path,message FROM history_source_issues WHERE provider=? ORDER BY path"
                )
                .all(providerId),
        };
    }
}

/** Status remains readable before the first compact migration and never initializes schema. */
export function readHistoryStatus(db: Database | undefined, providerId: string): NativeIndexStatus {
    const empty: NativeIndexStatus = { initialized: false, sessions: 0, sources: 0, messages: null, issues: [] };

    if (!db) {
        return empty;
    }

    const columns = db.query<{ name: string }, []>("PRAGMA table_info(session_metadata)").all();

    if (columns.some((column) => column.name === "source_key")) {
        return new HistorySyncRepository(db).status(providerId);
    }

    if (!columns.length || providerId !== "anthropic-sub") {
        return empty;
    }

    const sessions = db.query<{ count: number }, []>("SELECT count(*) AS count FROM session_metadata").get()!.count;
    const sourceTable = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='file_index'")
        .get();
    const counts = sourceTable
        ? db
              .query<{ sources: number; messages: number }, []>(
                  "SELECT count(*) AS sources, coalesce(sum(message_count),0) AS messages FROM file_index"
              )
              .get()
        : null;
    return {
        initialized: true,
        sessions,
        sources: counts?.sources ?? 0,
        messages: counts?.messages ?? null,
        issues: [],
    };
}
