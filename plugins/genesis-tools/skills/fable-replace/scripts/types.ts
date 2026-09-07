/**
 * fable-replace — the vocabulary. Every op shape, edit shape and result shape.
 * Pure types, zero imports, zero behaviour. Read this first to learn what can be
 * declared; read the module that owns each behaviour to learn what it does.
 */

/**
 * Literal find/replace. The workhorse — behaves like the Edit tool:
 * with `count: 1` (default) the needle must occur exactly once in the file;
 * `count: n` requires exactly n occurrences (all are replaced);
 * `count: "all"` replaces every occurrence and requires at least one.
 */
export interface LiteralOp {
    kind?: "replace";
    /** Exact text to find — copy it verbatim from the file, indentation included. */
    find: string;
    replace: string;
    /** Occurrence contract. Default 1 = "exactly once". */
    count?: number | "all";
    /** Match only where the needle STARTS a line, what `<<< delete` compiles to: "foo" never matches inside "notfoo". */
    wholeLines?: boolean;
    /** If true, a non-match is reported as SKIP instead of MISS and doesn't fail the run. */
    optional?: boolean;
    /** Free-text tag shown in the report instead of a needle preview. */
    label?: string;
}

/** Regex find/replace. `find` MUST carry the `g` flag when you expect multiple matches. */
export interface RegexOp {
    kind: "regex";
    find: RegExp;
    /** Replacement string ($1 etc. supported) or replacer function. */
    replace: string | ((substring: string, ...args: unknown[]) => string);
    /** Require exactly this many matches. Omit = require at least one. */
    expect?: number;
    optional?: boolean;
    label?: string;
}

/**
 * Delete everything between two anchors. The engine finds the `occurrence`-th
 * (default first) `from`, then the FIRST `to` after it.
 * `keepFrom`/`keepTo` (default false) keep the anchor text itself.
 */
export interface DeleteBlockOp {
    kind: "deleteBlock";
    from: string;
    to: string;
    keepFrom?: boolean;
    keepTo?: boolean;
    /** 1-based occurrence of `from` to anchor on. Default 1. */
    occurrence?: number;
    optional?: boolean;
    label?: string;
}

/** Like deleteBlock but substitutes `replace` for the removed region. */
export interface ReplaceBlockOp {
    kind: "replaceBlock";
    from: string;
    to: string;
    replace: string;
    keepFrom?: boolean;
    keepTo?: boolean;
    occurrence?: number;
    optional?: boolean;
    label?: string;
}

/**
 * Insert `text` immediately before/after the unique `anchor`, at that CHARACTER
 * position on the same line. Nothing is added around it: a trailing comment needs
 * its own leading space, a new line needs its own "\n". For whole lines under or
 * above the anchor's line use InsertLinesOp instead.
 */
export interface InsertOp {
    kind: "insertBefore" | "insertAfter";
    anchor: string;
    /** Inserted verbatim. */
    text: string;
    /** 1-based occurrence of the anchor. Default 1; anchor must occur at least that many times. */
    occurrence?: number;
    optional?: boolean;
    label?: string;
}

/**
 * Insert whole LINES before/after the line that contains the unique `anchor`.
 * The line-oriented cousin of InsertOp: "put this block under that line" without
 * caring where on the line the anchor sits. The anchor line itself stays exactly as
 * it was: never repeat it inside `text`. An anchor that starts with whitespace must
 * match at the start of a line, so a wrong indentation is a MISS, not a match.
 */
export interface InsertLinesOp {
    kind: "insertLinesBefore" | "insertLinesAfter";
    anchor: string;
    /** One or more lines, inserted literally: a trailing "\n" adds a blank line after the block. */
    text: string;
    optional?: boolean;
    label?: string;
}

/** Append lines at the end of the file. Literal like insertLines; the file always ends with one newline. */
export interface AppendOp {
    kind: "append";
    text: string;
    label?: string;
}

export type Op =
    | LiteralOp
    | RegexOp
    | DeleteBlockOp
    | ReplaceBlockOp
    | InsertOp
    | InsertLinesOp
    | AppendOp
    | DropCommentsOp
    | DeleteLinesOp
    | FuzzyOp;

export interface FileEdit {
    /** Path to the file (absolute, or relative to `opts.cwd` / process.cwd()). */
    file: string;
    /** Applied in order. Later ops see the output of earlier ones. */
    ops?: Op[];
    /** Delete the file as part of the batch (ops must be absent). */
    delete?: boolean;
    /** Rename/move the file after ops are applied. */
    renameTo?: string;
    /** Allow `renameTo` to replace an existing file. Off by default — it is data loss. */
    overwrite?: boolean;
    /** Edit this file even though it looks generated. Per-file, so one false positive does not disarm the guard for the whole batch. */
    allowGenerated?: boolean;
    /** Create the file with this content if it does not exist (ops then apply on top). */
    createWith?: string;
    /** Substrings that MUST be present after all ops ran. */
    expectAfter?: string[];
    /** Substrings that MUST NOT be present after all ops ran. */
    absentAfter?: string[];
}

export interface RunOptions {
    /** Preview only: print diffs, write nothing. Also enabled by `--dry` on argv. */
    dryRun?: boolean;
    /** Snapshot originals + manifest here before writing; enables `rollback()`. */
    backupDir?: string;
    /** Allow reusing a backupDir that already holds a manifest. Off: reuse loses the first snapshot. */
    backupOverwrite?: boolean;
    /** Resolve relative FileEdit.file paths against this directory. */
    cwd?: string;
    /**
     * Write the files that fully passed even when other files have misses. Default false
     * (transactional). A partial run with misses is still a FAILURE: `run()` throws (or
     * exits 1) AFTER writing, and `report.ok` is false.
     */
    partial?: boolean;
    /** Print per-op OK lines too (MISS/SKIP always print). Default true. */
    verbose?: boolean;
    /** Print the per-file diff on a REAL run too (dry runs always print it). Default false. */
    showDiff?: boolean;
    /** Max diff lines printed per file in dry runs. Default 200. */
    maxDiffLines?: number;
    /** Total diff lines across the WHOLE dry run before diffs are suppressed. Default 2000. */
    maxTotalDiffLines?: number;
    /** Allow editing paths containing node_modules (off by default on purpose). */
    allowNodeModules?: boolean;
    /** Allow editing files that look machine-generated (off by default on purpose). */
    allowGenerated?: boolean;
    /** Parse every edited .ts/.tsx/.js/.jsx after the ops and fail the file if the sweep broke it. Default on. */
    syntaxCheck?: boolean;
    /**
     * Default true: every failure throws a `FableReplaceError` whose `code` is the exit
     * code (1 misses/verify/partial, 2 pre-flight), so a script can catch it and read
     * the report. `false` calls `process.exit(code)` instead; the CLI does that.
     */
    throwOnFailure?: boolean;
    /**
     * Shell command executed AFTER a successful write (e.g. "tsgo --noEmit" or
     * "bun run test path/to/suite"), captured, with stdin closed. A non-zero exit fails
     * the run with code 3 and the sweep STAYS WRITTEN: rolling back would restore the
     * very needles a re-sent spec matches, and that loop costs a full-context round trip
     * per turn. The undo command is printed instead; `report.verify` carries the verdict.
     * A script that wants atomic behaviour writes `catch { rollback({ backupDir }) }`.
     * Skipped when the run has misses (`partial`), refused together with `dryRun`.
     */
    verifyCommand?: string;
    /** Backstop for a hung check, in milliseconds. Default 15 minutes; there is no CLI flag. */
    verifyTimeoutMs?: number;
    /**
     * Called once, right after the files are on disk and before any verify runs. The CLI
     * journals a "written" line here, so a check killed by a timeout still leaves a trace.
     */
    onWritten?: (info: { written: string[]; backupDir?: string }) => void;
    /**
     * After a successful write, scan `dirs` (default: cwd) for `names` and FAIL the run
     * when any survive in prose. The code is left written — a stale doc is a follow-up
     * edit, not a reason to roll back a green sweep.
     */
    leftoversCheck?: { names: string[]; dirs?: string[] };
}

export interface OpResult {
    status: "OK" | "MISS" | "SKIP";
    /** Human description of the op. */
    desc: string;
    /** Why it missed (only for MISS/SKIP). */
    reason?: string;
    /** How many occurrences were found (literal/regex ops). */
    found?: number;
    /** The count the op DECLARED (count / expect), echoed back so a green run still proves the contract. */
    expected?: number | "all";
    /** 1-based line numbers the op acted on, when it works line-wise (dropComments, deleteLines). */
    lines?: number[];
}

export interface FileResult {
    file: string;
    action: "edited" | "unchanged" | "deleted" | "renamed" | "created" | "failed-read";
    ops: OpResult[];
    postConditionFailures: string[];
    /** Content before/after (in memory) — present for edited files. */
    changed: boolean;
}

export interface RunReport {
    ok: boolean;
    files: FileResult[];
    written: string[];
    missCount: number;
    backupDir?: string;
    /** The captured verify verdict, when a verifyCommand ran. */
    verify?: VerifyResult;
}

export interface RunVerifyParams {
    /** The shell command, run through `sh -c` with cwd set. */
    command: string;
    cwd: string;
    /** Where `verify-output.txt` (the whole output) is written; none without a backup dir. */
    backupDir?: string;
    /** Default 15 minutes. */
    timeoutMs?: number;
}

export interface VerifyResult {
    command: string;
    /**
     * "pass" = exit 0. "fail" = a real non-zero exit. "unknown" = no exit status at all
     * (a signal, the timeout, output over the capture buffer): the sweep is on disk and
     * the verdict could not be measured, which is never reported as a test failure.
     */
    status: "pass" | "fail" | "unknown";
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    /** The output exceeded the capture buffer (ENOBUFS). */
    buffered: boolean;
    ms: number;
    /** Size of the whole captured output (stdout then stderr). */
    outputChars: number;
    /** The lines a reader is shown: the last 5 on a pass, head and tail on anything else. */
    shown: string[];
    /** The saved whole output, when a backup dir existed. */
    outputFile?: string;
    /** The spawn error message, when there was one. */
    error?: string;
}

export interface CommentSpan {
    /** Absolute start offset of the comment (including the // or slash-star). */
    start: number;
    /** Absolute end offset (exclusive). Line comments end BEFORE the newline. */
    end: number;
    /** The raw comment text, delimiters included. */
    text: string;
    type: "line" | "block";
    /** 1-based line the comment starts on. */
    line: number;
}

export interface DropCommentsOptions {
    /** Only drop comments whose text contains this substring. */
    containing?: string;
    /** Only drop comments whose text matches this regex. */
    matching?: RegExp;
    /** Restrict to line or block comments. Default both. */
    scope?: "line" | "block" | "both";
    /** Require exactly this many comments to be dropped. */
    expect?: number;
}

/** Op form of dropComments, usable inside a FileEdit. */
export interface DropCommentsOp extends DropCommentsOptions {
    kind: "dropComments";
    optional?: boolean;
    label?: string;
}

/** Delete every full line containing a substring / matching a regex. */
export interface DeleteLinesOp {
    kind: "deleteLines";
    containing?: string;
    matching?: RegExp;
    /** Require exactly this many lines removed. Omit = at least one. */
    expect?: number;
    optional?: boolean;
    label?: string;
}

/**
 * Fuzzy variant of a literal op (exactly-once contract, whitespace-insensitive on the
 * FIND side only). `replace` is written verbatim, indentation and line endings included.
 */
export interface FuzzyOp {
    kind: "fuzzy";
    find: string;
    replace: string;
    /** Occurrence contract, like LiteralOp. Default 1 = exactly once. */
    count?: number | "all";
    optional?: boolean;
    label?: string;
}

export interface RollbackReport {
    restored: string[];
    /** Paths skipped because they changed after the sweep wrote them. */
    drifted: string[];
    /** Paths the restore itself could not write, with the reason. These still hold the swept content. */
    failed: { file: string; error: string }[];
}

// ── parameter objects ────────────────────────────────────────────────────────
// Every exported function with more than two inputs takes ONE object, so a call
// reads as prose and the --api dump shows every field with its doc.

/** `run({ edits, ...options })`: the batch plus every RunOptions field. */
export interface RunParams extends RunOptions {
    edits: FileEdit[];
}

export interface PruneParams {
    /** Only dirs older than this are candidates. Default 12 hours. */
    ttlMs?: number;
    /** Cap per run, so a huge backlog is worked off over several runs. Default 50. */
    maxRemovals?: number;
    /** Dirs never touched, whatever their age: the current run's backup dir. */
    keep?: string[];
    /** The clock, for tests. */
    now?: number;
}

export interface PruneReport {
    scanned: number;
    removed: number;
    /** Sum of the file sizes in the removed dirs. */
    bytes: number;
    /** The `<tmp>/fable-replace` root that was swept: one, the temp dir this process writes to. */
    roots: string[];
}

export interface RollbackParams {
    backupDir: string;
    /** Restore files that changed after the sweep wrote them too. Default false. */
    force?: boolean;
    /**
     * Restore only these paths (as recorded in the manifest); every other entry is left
     * alone and not reported. The write-failure recovery passes the paths it actually wrote.
     */
    only?: string[];
}

export interface GrepPreviewParams {
    files: string[];
    /** A JS RegExp (lookahead works) or a literal string. */
    pattern: string | RegExp;
    /** Lines of context around each match. Default 2. */
    context?: number;
}

export interface LeftoversParams {
    /** Old names to hunt for. Identifiers are matched on word boundaries, anything else literally. */
    names: string[];
    /** Directories or files to scan. node_modules, build output and backup dirs are skipped. */
    dirs: string[];
    /** Suppress the printed summary. Default false. */
    quiet?: boolean;
}

export interface CountMatchesParams {
    files: string[];
    /** An identifier-looking string is matched on word boundaries; other strings literally; a RegExp as given (g forced). */
    pattern: string | RegExp;
    quiet?: boolean;
}

export interface FindFilesParams {
    roots: string[];
    /** Content filter: literal string or RegExp. REQUIRED — omitting it throws, rather than returning an empty list that reads as "no matches". */
    containing: string | RegExp;
    /** File extensions to keep. Default [".ts", ".tsx"]; [] keeps every file. */
    exts?: string[];
}

export interface SameOpsAcrossParams {
    files: string[];
    ops: Op[];
    /** Extra FileEdit fields (expectAfter, absentAfter, …) applied to every file. */
    extra?: Partial<FileEdit>;
}

export interface RenameSymbolParams {
    oldName: string;
    newName: string;
    /** Pin the match count for this one file. */
    expect?: number;
}

export interface RenameSymbolAcrossParams {
    /** A file list, or the map countMatches() returned (zero-match files are dropped, counts are pinned). */
    files: string[] | Record<string, number>;
    oldName: string;
    newName: string;
    extra?: Partial<FileEdit>;
    /**
     * A file that both IMPORTS and DECLARES `oldName` is a local wrapper; renaming its
     * declaration changes an unrelated helper, so such files are refused (thrown, code 2)
     * unless this is true. Drop them from `files` instead when in doubt.
     */
    includeShadowed?: boolean;
}

export interface ShadowedFilesParams {
    files: string[];
    /** The identifier being renamed. */
    name: string;
}

/** Sugar for a literal op: `all` (every occurrence) and `maybe` (optional). */
export interface LiteralSugarParams {
    find: string;
    replace: string;
    label?: string;
}

export interface DropParams {
    /** Exact chunk to delete; must occur exactly once. */
    find: string;
    label?: string;
}

export interface DropJsdocParams {
    /** The opening lines of the JSDoc block to delete, e.g. "/**\n * Legacy parity". */
    fromPrefix: string;
    label?: string;
}

export interface NearestHintParams {
    content: string;
    needle: string;
    /** When given, a needle whose replacement is already present is reported as "already applied". */
    replacement?: string;
    /**
     * The content BEFORE any op of this batch ran (what is on disk). With it, a replacement
     * that is present in `content` but absent here is blamed on an earlier op of the batch,
     * not on a previous run.
     */
    original?: string;
    /** The most recent earlier op of the batch that changed the content, for the blame line. */
    producedBy?: { index: number; desc: string };
}

export interface NthIndexOfParams {
    haystack: string;
    needle: string;
    /** 1-based occurrence. */
    n: number;
}

export interface SimpleDiffParams {
    before: string;
    after: string;
    /** Cap on printed lines. Default 200. */
    maxLines?: number;
}
/** `writeBackup({ dir, files, overwrite })`: snapshot the originals before a sweep writes. */
export interface WriteBackupParams {
    dir: string;
    /** Absolute paths to snapshot; a path that does not exist is recorded as "created by this sweep". */
    files: string[];
    /** Replace a manifest left by an earlier sweep in the same dir. Default false, which is a loud refusal. */
    overwrite?: boolean;
}
