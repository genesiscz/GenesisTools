// Shapes of `tools du index`. The JSON forms are a contract: the Genesis app decodes
// them, and src/macos/GenesisKit/Sources/GenesisKitFixtures/Disk/contract-du-index-* holds one example of each (a
// test keeps the keys and nesting of real output equal to those fixtures).

export type IndexFormat = "human" | "json" | "ndjson";

export type IndexErrorCode =
    | "locked"
    | "schema_newer"
    | "volume_changed"
    | "root_changed"
    | "walk_failed"
    | "aborted"
    | "disk_low"
    | "not_built"
    | "no_snapshot"
    | "usage"
    | "inconsistent"
    | "failed";

export const EXIT_CODES: Record<IndexErrorCode, number> = {
    locked: 3,
    schema_newer: 4,
    usage: 2,
    aborted: 130,
    volume_changed: 1,
    root_changed: 1,
    walk_failed: 1,
    disk_low: 1,
    not_built: 1,
    no_snapshot: 1,
    inconsistent: 1,
    failed: 1,
};

export class IndexError extends Error {
    readonly code: IndexErrorCode;
    readonly exitCode: number;

    constructor(code: IndexErrorCode, message: string) {
        super(message);
        this.name = "IndexError";
        this.code = code;
        this.exitCode = EXIT_CODES[code];
    }
}

/** The `error` object every machine format ends with. */
export function errorEvent(command: string, err: IndexError): ErrorEvent {
    return { type: "error", command, code: err.code, message: err.message, exit_code: err.exitCode };
}

/** One `dirs` row as stored. */
export interface DirRow {
    id: number;
    parent_id: number;
    name: string;
    fileid: number;
    alloc_bytes: number;
    logical_bytes: number;
    private_bytes: number | null;
    files: number;
    dirs: number;
    max_file_bytes: number;
    newest_mtime_s: number;
    dir_mtime_ms: number;
    flags: number;
    scan_id: number;
    first_scan_id: number;
}

export interface StartEvent {
    type: "start";
    command: "build" | "update";
    schema_version: number;
    scan_id: number;
    root: string;
    db: string;
    threads: number;
    private: boolean;
    started_at_ms: number;
}

export interface ProgressEvent {
    type: "progress";
    phase: "walk";
    files: number;
    dirs: number;
    bytes: number;
    elapsed_ms: number;
    files_per_s: number;
    dir: string;
}

/** A folder the walk gave up because its listing made no progress (usually a macOS privacy prompt). */
export interface BlockedEvent {
    type: "blocked";
    phase: "walk";
    path: string;
    waited_ms: number;
}

export interface PhaseEvent {
    type: "phase";
    phase: "ingest" | "commit" | "checkpoint";
    rows: number | null;
    elapsed_ms: number;
}

export interface ErrorEvent {
    type: "error";
    command: string;
    code: IndexErrorCode;
    message: string;
    exit_code: number;
}

export interface BuildResult {
    type: "result";
    command: "build";
    schema_version: number;
    scan_id: number;
    snapshot_id: number | null;
    root: string;
    db: string;
    threads: number;
    private: boolean;
    min_dir_bytes: number;
    big_file_floor: number;
    files: number;
    dirs: number;
    stored_dirs: number;
    folded_dirs: number;
    big_files: number;
    alloc_bytes: number;
    logical_bytes: number;
    private_bytes: number | null;
    denied_dirs: number;
    vanished_dirs: number;
    read_errors: number;
    skipped_cloud: string[];
    skipped_mounts: string[];
    /** Folders given up by the stall watchdog; their rows carry flag 32 and miss their own bytes. */
    blocked_dirs: number;
    blocked_paths: string[];
    /** Why the database was emptied before this build, or null when it was not. */
    reset: "volume_changed" | "requested" | null;
    walk_ms: number;
    ingest_ms: number;
    elapsed_ms: number;
    db_bytes: number;
}

export interface RegionDelta {
    alloc_bytes: number;
    logical_bytes: number;
    private_bytes: number | null;
    files: number;
    dirs: number;
}

export interface RegionResult {
    owner: string;
    owner_id: number;
    files: number;
    dirs: number;
    kept: number;
    walk_ms: number;
    delta: RegionDelta;
}

export interface UpdateResult {
    type: "result";
    command: "update";
    schema_version: number;
    /** Null when the paths were queued because a build held the lock. */
    scan_id: number | null;
    root: string;
    deferred: boolean;
    queued: number;
    regions: RegionResult[];
    promoted: number;
    removed: number;
    /** Paths outside the indexed root; nothing was done for them. */
    ignored: string[];
    elapsed_ms: number;
}

export type IndexEvent =
    | StartEvent
    | ProgressEvent
    | BlockedEvent
    | PhaseEvent
    | ErrorEvent
    | BuildResult
    | UpdateResult;

export interface AsOf {
    scan_id: number;
    kind: "build" | "update";
    status: string;
    finished_at_ms: number | null;
    age_s: number | null;
    last_build_scan_id: number | null;
    last_build_at_ms: number | null;
}

export interface NodeOut {
    id: number;
    parent_id: number;
    name: string;
    path: string;
    alloc_bytes: number;
    logical_bytes: number;
    private_bytes: number | null;
    files: number;
    dirs: number;
    max_file_bytes: number;
    newest_mtime_s: number;
    dir_mtime_ms: number;
    flags: number;
    scan_id: number;
    stored_children: number;
}

export interface ChildOut extends NodeOut {
    /** This child's share of the parent's allocated bytes, 0 to 1. */
    share: number;
}

export interface LocalOut {
    alloc_bytes: number;
    logical_bytes: number;
    private_bytes: number | null;
    files: number;
    dirs: number;
}

export interface TopFile {
    path: string;
    logical_bytes: number;
    alloc_bytes: number;
    mtime_ms: number;
    nlink: number;
}

export interface QueryFound {
    schema_version: number;
    found: true;
    as_of: AsOf;
    root: string;
    path: string;
    node: NodeOut;
    local: LocalOut;
    children: ChildOut[];
    top_files: TopFile[];
    truncated: boolean;
    /** Folders under this one (itself included) that a walk gave up (flag 32): their own bytes are missing. */
    blocked_below: number;
}

export interface QueryNotFound {
    schema_version: number;
    found: false;
    as_of: AsOf;
    root: string;
    path: string;
    /** folded: inside a stored directory, below the size cutoff. missing: not on disk. */
    reason: "folded" | "missing" | "outside_root";
    folded_in: string | null;
    hint: string;
}

export interface LargestDirRow extends NodeOut {
    local_alloc_bytes: number;
}

interface QueryLargestBase {
    schema_version: number;
    as_of: AsOf;
    root: string;
    truncated: boolean;
}

export type QueryLargest = QueryLargestBase &
    ({ largest: "dirs"; rows: LargestDirRow[] } | { largest: "files"; rows: TopFile[] });

export interface ScanInfo {
    id: number;
    kind: string;
    status: string;
    started_at_ms: number;
    finished_at_ms: number | null;
    files: number | null;
    dirs: number | null;
    alloc_bytes: number | null;
    walk_ms: number | null;
    threads: number | null;
}

export interface QueryInfo {
    schema_version: number;
    db: string;
    db_bytes: number;
    root: string;
    as_of: AsOf | null;
    meta: Record<string, string>;
    counts: {
        dirs: number;
        tombstones: number;
        big_files: number;
        snapshots: number;
        snapshot_dirs: number;
        dirty_queue: number;
        /** Live rows with flag 32 (given up by the walk): the totals above them are short. */
        blocked: number;
    };
    scans: ScanInfo[];
}

export type DiffStatus = "grown" | "shrunk" | "new" | "gone";

export interface DiffRowOut {
    path: string;
    /** Null when the directory was below the snapshot floor at that time. */
    before: number | null;
    /** Null when the directory was below the snapshot floor at that time. */
    after: number | null;
    delta: number;
    status: DiffStatus;
    files_delta: number;
    /** True when one side is below the floor, so `delta` is an estimate. */
    approx: boolean;
}

export interface DiffResult {
    schema_version: number;
    root: string;
    from: { snapshot_id: number; scan_id: number; taken_at_ms: number };
    to: { snapshot_id: number | null; scan_id: number; taken_at_ms: number; live: boolean };
    floor: number;
    attribute: "leaf" | "all";
    total_delta: { alloc_bytes: number; files: number };
    rows: DiffRowOut[];
    truncated: boolean;
}

export interface ScheduleStatus {
    task: string;
    registered: boolean;
    every: string | null;
    command: string | null;
}
