/** Current on-disk index schema version. Bump when {@link RegretEntry} changes. */
export const INDEX_VERSION = 1;

/**
 * One indexed bug-fix commit, reduced to the lexical signal we score against.
 */
export interface RegretEntry {
    /** Abbreviated commit hash. */
    hash: string;
    /** Commit subject line. */
    subject: string;
    /** Author date (ISO 8601). */
    date: string;
    /** Author date as a unix-seconds timestamp (for deterministic tie-breaks). */
    timestamp: number;
    /** Distinct file-type tokens touched by the commit (e.g. `ts`, `tsx`). */
    fileTypes: string[];
    /** Salient lexical tokens distilled from subject + diff. */
    tokens: string[];
}

/**
 * The persisted index: a versioned bag of bug-fix entries.
 */
export interface RegretIndex {
    version: number;
    /** Absolute path of the repo this index was built from. */
    repo: string;
    /** When the index was last built (ISO 8601). */
    builtAt: string;
    entries: RegretEntry[];
}

/**
 * A raw bug-fix commit pulled from git, before token distillation.
 */
export interface RawCommit {
    hash: string;
    subject: string;
    date: string;
    timestamp: number;
    /** Files changed by the commit. */
    files: string[];
    /** Added/removed diff lines (content only, no `+++`/`---` headers). */
    diffLines: string[];
}
