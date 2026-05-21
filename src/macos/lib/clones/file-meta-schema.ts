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
    /** SHA-256 of the first 4 KB of the file (lowercase hex). Used by P3
     *  prefix-hash pre-filter. Empty string for rows that haven't been
     *  re-hashed since the column was added — the detector recomputes on
     *  next visit and writes back. */
    prefix_hash: string;
    /** APFS clone-family id as lowercase hex, or '' for files without one. */
    clone_id: string;
    /** Epoch-ms timestamp of the scan that last touched this row. Drives
     *  pruning of rows whose files have disappeared since their scan. */
    last_seen_at: bigint;
}

export interface DirMetaTable {
    /** Absolute directory path. Primary key. */
    path: string;
    /** Directory's mtime in nanoseconds. APFS (POSIX 1003.1-2001 §4.7) bumps
     *  this only on namespace changes (add/remove/rename of immediate
     *  children); content edits on existing children do NOT bump. */
    dir_mtime_ns: bigint;
    /** Inode number. Detects "directory was deleted and recreated with the
     *  same name" — different inode → invalidate. */
    ino: bigint;
    /** SafeJSON-stringified array of `{ name, kind }` for each immediate
     *  child. Re-read from this when dir_mtime_ns matches; replays the
     *  readdirSync result without the syscall. */
    child_names_json: string;
    /** Epoch-ms of last refresh. Same TTL prune semantics as file_meta. */
    last_seen_at: bigint;
}

export interface FileMetaDB {
    file_meta: FileMetaTable;
    dir_meta: DirMetaTable;
}
