/** Inclusive, 1-based source lines. */
export interface LineRange {
    startLine: number;
    endLine: number;
}

/**
 * What a lookup through the caller's policy found.
 *
 * - `file`: present and readable under the policy.
 * - `missing`: nothing at that path.
 * - `skipped`: the policy never looks there (a dot path when hidden paths are off). Not an error.
 * - `withheld`: something is there, but the policy keeps it out (ignored, sensitive, symlink, not a file).
 * - `unreadable`: the lookup itself failed; the answer is unknown.
 */
export type RepoLookup = "file" | "missing" | "skipped" | "withheld" | "unreadable";

/**
 * The only way a gatherer touches the tree. Paths are relative to the context root with `/`
 * separators, and `.` is the root. A reader never answers for anything above the root, so a
 * gatherer cannot either; that is what keeps a scoped search from reporting its parent's files.
 */
export interface RepoContextReader {
    lookup(path: string): Promise<RepoLookup>;
    /** UTF-8 text, or undefined when the file is missing, withheld, unreadable, or changed. */
    readText(path: string): Promise<string | undefined>;
}

/** A file the caller is about to hand to its reader, with what it already knows about it. */
export interface ContextTarget {
    path: string;
    /** Caller-assigned roles, such as `implementation` or `test`. Free-form. */
    roles: readonly string[];
    /** Lines the caller will show. Test cases count only when one of these ranges covers them. */
    shownRanges: readonly LineRange[];
}

export interface GatherScope {
    reader: RepoContextReader;
    targets: readonly ContextTarget[];
    /** `.` first, then every ancestor directory of every target, parents before children, never above the root. */
    directories: readonly string[];
    signal?: AbortSignal;
}

export interface ContextGatherer<Id extends string = string, Result = unknown> {
    readonly id: Id;
    gather(scope: GatherScope): Promise<Result>;
}

export type GathererResult<G> = G extends ContextGatherer<string, infer Result> ? Result : never;

export interface GatherOutcome<G extends ContextGatherer> {
    /** One entry per gatherer that finished. A failed gatherer has no entry and is named in `failed`. */
    results: { [Gt in G as Gt["id"]]?: GathererResult<Gt> };
    failed: string[];
}
