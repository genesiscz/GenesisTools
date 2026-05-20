/** Kysely-typed schema for the file-meta cache db. Used to anchor the
 *  `createKyselyClient<FileMetaDB>` type parameter. */
export interface FileMetaTable {
    /** Absolute filesystem path. Primary key. */
    path: string;
    /** Logical file size in bytes. */
    size: bigint;
    /** mtime in nanoseconds (APFS resolution). Past Number.MAX_SAFE_INTEGER —
     *  the cache driver MUST open the db with `safeIntegers: true` (constructor
     *  option to `new Database()`) so integers round-trip as bigint, not lossy
     *  number. */
    mtime_ns: bigint;
    /** SHA-256 of file contents (lowercase hex, no prefix). */
    sha256: string;
    /** APFS clone-family id as lowercase hex, or '' for files without one. */
    clone_id: string;
    /** Epoch-ms timestamp of the scan that last touched this row. Drives
     *  pruning of rows whose files have disappeared since their scan. */
    last_seen_at: bigint;
}

export interface FileMetaDB {
    file_meta: FileMetaTable;
}
