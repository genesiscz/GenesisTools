import type { Database } from "bun:sqlite";
import { isAbsolute, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { SessionMetadataRecord } from "./cache-types";
import { unresolvedHistorySourceKey } from "./identity";
import { boundHistoryMetadata } from "./metadata";
import type { BoundedMetadataField, HistoryMetadataRecord } from "./types";

export interface CachedHistoryMetadata extends SessionMetadataRecord {
    providerId: string;
    sourceKey: string;
    sourceHome: string | null;
    nativeId: string | null;
    parentNativeId: string | null;
    root: string | null;
    projectDirectory: string | null;
    lastTimestamp: string | null;
    archived: boolean;
    resumeMode: "native" | "unsupported";
    identityStatus: "legacy" | "resolved";
    boundedFields: BoundedMetadataField[];
    storageTruncatedFields?: BoundedMetadataField[];
}

export interface HistorySourceSnapshot {
    sourceKey: string;
    providerId: string;
    filePath: string;
    root: string | null;
    metadataRevision: string | null;
    metadataParserVersion: string | null;
    statsRevision: string | null;
    statsInputsRevision?: string | null;
    statisticsStatus: string;
    generation: number;
}

interface MetadataRow {
    source_key: string;
    provider: string;
    source_home: string | null;
    native_id: string | null;
    parent_native_id: string | null;
    root: string | null;
    file_path: string;
    session_id: string | null;
    custom_title: string | null;
    summary: string | null;
    first_prompt: string | null;
    all_user_text: string | null;
    git_branch: string | null;
    project: string | null;
    cwd: string | null;
    mtime: number;
    first_timestamp: string | null;
    last_timestamp: string | null;
    project_directory: string | null;
    is_subagent: number;
    archived: number;
    resume_mode: string;
    identity_status: string;
    bounded_fields: string;
    storage_truncated_fields: string;
}

interface SourceRow {
    source_key: string;
    provider: string;
    file_path: string;
    root: string | null;
    metadata_revision: string | null;
    metadata_parser_version: string | null;
    stats_revision: string | null;
    stats_inputs_revision: string | null;
    statistics_status: string;
    generation: number;
}

function decodeMetadata(row: MetadataRow): CachedHistoryMetadata {
    return {
        providerId: row.provider,
        sourceKey: row.source_key,
        sourceHome: row.source_home,
        nativeId: row.native_id,
        parentNativeId: row.parent_native_id,
        root: row.root,
        filePath: row.file_path,
        sessionId: row.session_id,
        customTitle: row.custom_title,
        summary: row.summary,
        firstPrompt: row.first_prompt,
        allUserText: row.all_user_text,
        gitBranch: row.git_branch,
        project: row.project,
        cwd: row.cwd,
        mtime: row.mtime,
        firstTimestamp: row.first_timestamp,
        lastTimestamp: row.last_timestamp,
        projectDirectory: row.project_directory,
        isSubagent: row.is_subagent === 1,
        archived: row.archived === 1,
        resumeMode: row.resume_mode === "native" ? "native" : "unsupported",
        identityStatus: row.identity_status === "resolved" ? "resolved" : "legacy",
        boundedFields: SafeJSON.parse(row.bounded_fields, { strict: true }) as BoundedMetadataField[],
        storageTruncatedFields: SafeJSON.parse(row.storage_truncated_fields, {
            strict: true,
        }) as BoundedMetadataField[],
    };
}

/** SQL only. Opening a repository neither initializes schema nor discovers sources. */
export class HistoryRepository {
    constructor(private readonly db: Database) {}

    getSource(sourceKey: string): HistorySourceSnapshot | null {
        const row = this.db.query<SourceRow, [string]>("SELECT * FROM file_index WHERE source_key = ?").get(sourceKey);

        if (row) {
            return {
                sourceKey: row.source_key,
                providerId: row.provider,
                filePath: row.file_path,
                root: row.root,
                metadataRevision: row.metadata_revision,
                metadataParserVersion: row.metadata_parser_version,
                statsRevision: row.stats_revision,
                statsInputsRevision: row.stats_inputs_revision,
                statisticsStatus: row.statistics_status,
                generation: row.generation,
            };
        }

        const metadata = this.db
            .query<Pick<MetadataRow, "source_key" | "provider" | "file_path">, [string]>(
                "SELECT source_key, provider, file_path FROM session_metadata WHERE source_key = ?"
            )
            .get(sourceKey);

        return metadata
            ? {
                  sourceKey: metadata.source_key,
                  providerId: metadata.provider,
                  filePath: metadata.file_path,
                  root: null,
                  metadataRevision: null,
                  metadataParserVersion: null,
                  statsRevision: null,
                  statisticsStatus: "unavailable",
                  generation: 0,
              }
            : null;
    }

    listSources(providerId: string): HistorySourceSnapshot[] {
        const rows = this.db
            .query<SourceRow, [string, string]>(`
            SELECT source_key,provider,file_path,root,metadata_revision,metadata_parser_version,
                stats_revision,stats_inputs_revision,statistics_status,generation FROM file_index WHERE provider=?
            UNION ALL
            SELECT m.source_key,m.provider,m.file_path,NULL,NULL,NULL,NULL,NULL,'unavailable',0
                FROM session_metadata m WHERE m.provider=? AND NOT EXISTS (
                    SELECT 1 FROM file_index f WHERE f.source_key=m.source_key
                )
        `)
            .all(providerId, providerId);
        return rows.map((row) => ({
            sourceKey: row.source_key,
            providerId: row.provider,
            filePath: row.file_path,
            root: row.root,
            metadataRevision: row.metadata_revision,
            metadataParserVersion: row.metadata_parser_version,
            statsRevision: row.stats_revision,
            statsInputsRevision: row.stats_inputs_revision,
            statisticsStatus: row.statistics_status,
            generation: row.generation,
        }));
    }

    listMetadata(options: {
        providerId: string;
        sourceKeys?: string[];
        filePaths?: string[];
        boundedOnly?: boolean;
        filePath?: string;
        sessionId?: string;
        project?: string;
        pathPrefix?: string;
        orderBy?: "mtime" | "firstTimestamp";
        limit?: number;
    }): CachedHistoryMetadata[] {
        if (options.sourceKeys?.length === 0 || options.filePaths?.length === 0) {
            return [];
        }

        const clauses = ["m.provider = ?"];
        const params: Array<string | number> = [options.providerId];

        if (options.sourceKeys?.length === 1) {
            clauses.push("m.source_key = ?");
            params.push(options.sourceKeys[0]);
        } else if (options.sourceKeys) {
            clauses.push(`m.source_key IN (SELECT value FROM json_each(?))`);
            params.push(SafeJSON.stringify(options.sourceKeys));
        }
        if (options.filePaths?.length === 1) {
            clauses.push("m.file_path = ?");
            params.push(options.filePaths[0]);
        } else if (options.filePaths) {
            clauses.push("m.file_path IN (SELECT value FROM json_each(?))");
            params.push(SafeJSON.stringify(options.filePaths));
        }
        if (options.boundedOnly) {
            clauses.push("json_array_length(m.storage_truncated_fields) > 0");
        }
        if (options.filePath !== undefined) {
            clauses.push("m.file_path = ?");
            params.push(options.filePath);
        }
        if (options.sessionId !== undefined) {
            clauses.push("m.session_id = ?");
            params.push(options.sessionId);
        }
        if (options.project !== undefined) {
            clauses.push("m.project = ?");
            params.push(options.project);
        }
        if (options.pathPrefix !== undefined) {
            clauses.push("m.file_path LIKE ?");
            params.push(`${options.pathPrefix}%`);
        }
        const order = options.orderBy === "firstTimestamp" ? "COALESCE(m.first_timestamp, '') DESC" : "m.mtime DESC";
        const limit = options.limit === undefined ? "" : " LIMIT ?";
        if (options.limit !== undefined) {
            params.push(options.limit);
        }
        return (
            this.db
                .query(`
                    SELECT m.*, f.root FROM session_metadata m
                    LEFT JOIN file_index f ON f.source_key = m.source_key
                    WHERE ${clauses.join(" AND ")} ORDER BY ${order}${limit}
                `)
                .all(...params) as MetadataRow[]
        ).map(decodeMetadata);
    }

    getMetadataBySourceKey(options: { providerId: string; sourceKey: string }): CachedHistoryMetadata | null {
        return (
            this.listMetadata({ providerId: options.providerId, sourceKeys: [options.sourceKey], limit: 1 })[0] ?? null
        );
    }

    getMetadataByFilePath(options: { providerId: string; filePath: string }): CachedHistoryMetadata | null {
        return this.listMetadata({ ...options, limit: 1 })[0] ?? null;
    }

    getMetadataBySessionId(options: { providerId: string; sessionId: string }): CachedHistoryMetadata | null {
        const exact = this.listMetadata({ ...options, limit: 1 })[0];
        if (exact) {
            return exact;
        }
        const suffix = `${sep}${options.sessionId}.jsonl`;
        const row = this.db
            .query<MetadataRow, [string, string]>(`
                SELECT m.*, f.root FROM session_metadata m
                LEFT JOIN file_index f ON f.source_key = m.source_key
                WHERE m.provider = ? AND m.file_path LIKE ? LIMIT 1
            `)
            .get(options.providerId, `%${suffix}`);
        return row ? decodeMetadata(row) : null;
    }

    getMetadataByDir(options: { providerId: string; dirPath: string }): CachedHistoryMetadata[] {
        const prefix = options.dirPath.endsWith(sep) ? options.dirPath : `${options.dirPath}${sep}`;
        return this.listMetadata({
            providerId: options.providerId,
            pathPrefix: prefix,
            orderBy: "firstTimestamp",
        });
    }

    getMetadataByProject(options: { providerId: string; project: string }): CachedHistoryMetadata[] {
        return this.listMetadata({
            providerId: options.providerId,
            project: options.project,
            orderBy: "firstTimestamp",
        });
    }

    upsertLegacyMetadata(options: { providerId: string; record: SessionMetadataRecord }): void {
        const existing = this.getMetadataByFilePath({
            providerId: options.providerId,
            filePath: options.record.filePath,
        });
        const sourceKey =
            existing?.sourceKey ??
            unresolvedHistorySourceKey({
                providerId: options.providerId,
                filePath: options.record.filePath,
            });
        this.db
            .query(`
                INSERT INTO session_metadata (
                    source_key, provider, file_path, session_id, custom_title, summary,
                    first_prompt, git_branch, project, cwd, mtime, first_timestamp,
                    is_subagent, all_user_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_key) DO UPDATE SET
                    file_path = excluded.file_path,
                    session_id = excluded.session_id,
                    custom_title = excluded.custom_title,
                    summary = excluded.summary,
                    first_prompt = excluded.first_prompt,
                    git_branch = excluded.git_branch,
                    project = excluded.project,
                    cwd = excluded.cwd,
                    mtime = excluded.mtime,
                    first_timestamp = excluded.first_timestamp,
                    is_subagent = excluded.is_subagent,
                    all_user_text = excluded.all_user_text
            `)
            .run(
                sourceKey,
                options.providerId,
                options.record.filePath,
                options.record.sessionId,
                options.record.customTitle,
                options.record.summary,
                options.record.firstPrompt,
                options.record.gitBranch,
                options.record.project,
                options.record.cwd,
                options.record.mtime,
                options.record.firstTimestamp,
                options.record.isSubagent ? 1 : 0,
                options.record.allUserText
            );
    }

    removeMetadata(options: { providerId: string; filePath: string }): void {
        this.removeMetadataBatch({ providerId: options.providerId, filePaths: [options.filePath] });
    }

    removeMetadataBatch(options: { providerId: string; filePaths: string[] }): void {
        if (options.filePaths.length === 0) {
            return;
        }
        const statement = this.db.prepare("DELETE FROM session_metadata WHERE provider = ? AND file_path = ?");
        const invalidate = this.db.prepare(
            "UPDATE file_index SET metadata_revision=NULL, metadata_parser_version=NULL WHERE provider=? AND file_path=?"
        );
        this.db
            .transaction((filePaths: string[]) => {
                for (const filePath of filePaths) {
                    statement.run(options.providerId, filePath);
                    invalidate.run(options.providerId, filePath);
                }
            })
            .immediate(options.filePaths);
    }

    clearMetadata(providerId: string): void {
        this.db
            .transaction(() => {
                this.db.query("DELETE FROM session_metadata WHERE provider = ?").run(providerId);
                this.db
                    .query(
                        "UPDATE file_index SET metadata_revision=NULL, metadata_parser_version=NULL WHERE provider=?"
                    )
                    .run(providerId);
            })
            .immediate();
    }

    /**
     * Rows the one-way migration carried over with a synthesized `source_key` and no source home.
     * Each ordinary search heals only the sources it refreshes, so after a migration the listing
     * is quietly short until enough searches have run — and nothing said so. Callers use this to
     * name the one command that finishes the job.
     */
    unresolvedIdentityCount(providerId: string): number {
        return this.db
            .query<{ n: number }, [string]>(
                "SELECT count(*) AS n FROM session_metadata WHERE provider = ? AND identity_status <> 'resolved'"
            )
            .get(providerId)!.n;
    }

    listMetadataFilePaths(providerId: string): string[] {
        return this.db
            .query<{ file_path: string }, [string]>(
                "SELECT file_path FROM session_metadata WHERE provider = ? ORDER BY file_path"
            )
            .all(providerId)
            .map((row) => row.file_path);
    }

    replaceMetadata(options: {
        metadata: HistoryMetadataRecord;
        revision: string;
        parserVersion: string;
        generation: number;
        expected: HistorySourceSnapshot | null;
    }): boolean {
        const { expected } = options;
        const metadata = boundHistoryMetadata(options.metadata);

        if (
            !metadata.providerId.trim() ||
            !metadata.nativeId.trim() ||
            !isAbsolute(metadata.sourceHome) ||
            metadata.sourceKey !== SafeJSON.stringify([metadata.providerId, metadata.sourceHome, metadata.nativeId])
        ) {
            throw new Error("Metadata source key does not match its provider/home/native identity");
        }

        return this.db
            .transaction(() => {
                const previous = this.getSource(expected?.sourceKey ?? metadata.sourceKey);

                if (
                    (expected === null && previous !== null) ||
                    (expected !== null &&
                        (previous === null ||
                            previous.providerId !== metadata.providerId ||
                            previous.filePath !== expected.filePath ||
                            previous.metadataRevision !== expected.metadataRevision ||
                            previous.generation !== expected.generation ||
                            previous.generation > options.generation))
                ) {
                    return false;
                }

                if (expected && expected.sourceKey !== metadata.sourceKey) {
                    if (this.getSource(metadata.sourceKey)) {
                        return false;
                    }

                    this.db
                        .query("UPDATE session_metadata SET source_key = ? WHERE source_key = ?")
                        .run(metadata.sourceKey, expected.sourceKey);
                    this.db
                        .query("UPDATE file_index SET source_key = ? WHERE source_key = ?")
                        .run(metadata.sourceKey, expected.sourceKey);
                    this.db
                        .query("UPDATE file_daily_stats SET source_key = ? WHERE provider = ? AND source_key = ?")
                        .run(metadata.sourceKey, metadata.providerId, expected.sourceKey);
                }

                this.db
                    .query(`
                INSERT INTO session_metadata (
                    source_key, provider, source_home, native_id, parent_native_id,
                    file_path, session_id, custom_title, summary, first_prompt, all_user_text,
                    git_branch, project, cwd, mtime, first_timestamp, last_timestamp,
                    project_directory, is_subagent, archived, resume_mode, identity_status, bounded_fields, storage_truncated_fields
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?)
                ON CONFLICT(source_key) DO UPDATE SET
                    provider = excluded.provider, source_home = excluded.source_home,
                    native_id = excluded.native_id, parent_native_id = excluded.parent_native_id,
                    file_path = excluded.file_path, session_id = excluded.session_id,
                    custom_title = excluded.custom_title, summary = excluded.summary,
                    first_prompt = excluded.first_prompt, all_user_text = excluded.all_user_text,
                    git_branch = excluded.git_branch, project = excluded.project, cwd = excluded.cwd,
                    mtime = excluded.mtime, first_timestamp = excluded.first_timestamp,
                    last_timestamp = excluded.last_timestamp, project_directory = excluded.project_directory,
                    is_subagent = excluded.is_subagent, archived = excluded.archived,
                    resume_mode = excluded.resume_mode, identity_status = 'resolved', bounded_fields = excluded.bounded_fields,
                    storage_truncated_fields = excluded.storage_truncated_fields
            `)
                    .run(
                        metadata.sourceKey,
                        metadata.providerId,
                        metadata.sourceHome,
                        metadata.nativeId,
                        metadata.parentNativeId ?? null,
                        metadata.filePath,
                        metadata.sessionId,
                        metadata.customTitle,
                        metadata.summary,
                        metadata.firstPrompt,
                        metadata.allUserText,
                        metadata.gitBranch,
                        metadata.project,
                        metadata.cwd,
                        metadata.mtime,
                        metadata.firstTimestamp,
                        metadata.lastTimestamp ?? null,
                        metadata.projectDirectory ?? null,
                        metadata.isSubagent ? 1 : 0,
                        metadata.archived ? 1 : 0,
                        metadata.resumeMode,
                        SafeJSON.stringify(metadata.boundedFields),
                        SafeJSON.stringify(metadata.storageTruncatedFields ?? [])
                    );
                this.db
                    .query(`
                INSERT INTO file_index (source_key, provider, file_path, root, mtime, last_indexed,
                    metadata_revision, metadata_parser_version, generation)
                VALUES (?, ?, ?, ?, -1, '', ?, ?, ?)
                ON CONFLICT(source_key) DO UPDATE SET
                    file_path = excluded.file_path, root = excluded.root,
                    metadata_revision = excluded.metadata_revision,
                    metadata_parser_version = excluded.metadata_parser_version, generation = excluded.generation
            `)
                    .run(
                        metadata.sourceKey,
                        metadata.providerId,
                        metadata.filePath,
                        metadata.root,
                        options.revision,
                        options.parserVersion,
                        options.generation
                    );
                return true;
            })
            .immediate();
    }
}
