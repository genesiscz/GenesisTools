/** A file that holds more than one branch's part (the app's part registration). */
export interface DerivedFile {
    file: string;
    /** The text the edits start from: unified's (the default) or the base's. */
    from?: "unified" | "base";
    /** Applied to that text in order; each one must match, so a changed file fails loudly instead of drifting. */
    edits: readonly (readonly [RegExp, string])[];
}

/** One branch of the cut. `parent` names an earlier branch, or null for the base ref. */
export interface CutBranch {
    name: string;
    parent: string | null;
    /** The commit subject, in the repo's scope vocabulary (scripts/git/commit-scopes.ts). */
    subject: string;
    /** A file comes here only when a selected commit with one of these scopes touched it. */
    scopes: readonly string[];
    /** Path globs; a leading `!` excludes. The most specific matching glob (longest literal prefix) wins. */
    globs: readonly string[];
    /** When set, the branch takes only files whose every touching commit matches one of these, and outranks globs. */
    commits?: readonly RegExp[];
    /** Files whose form on this branch is unified's text with edits, because they also register another branch's part. */
    derived?: readonly DerivedFile[];
    /**
     * Files that belong here whatever the globs say and never move: a test that reads another language's file of
     * this branch by path, which no import shows (service.test.ts reads the Swift editor's tab list).
     */
    stays?: readonly string[];
    /**
     * Folders this branch takes whole: every file under them that differs between the base and unified and that no
     * other branch holds, whatever commit changed it. For a feature whose commits carry scopes outside the selection
     * (the app lifecycle's `(GenesisHub, app)` commits), so the branch does not hold half of it.
     */
    sweep?: readonly string[];
    /** Run one `swift build --build-tests` of the app package on this tree when --swift is given. */
    swift?: boolean;
}

export interface CutTable {
    branches: readonly CutBranch[];
    keepAtBase: Record<string, string>;
    defaults: { unified: string; unifiedBranch: string; base: string };
    selection: "commits" | "diff";
    refPrefix: string;
}
