/** Scope names tools already pass to `profiler.scope()`. `--scopes` help lists these. */
export const PROFILER_SCOPE_NAMES = [
    "claude-history",
    "du",
    "du.engine",
    "du.bun",
    "clones",
    "teams",
    "claude-cmux-tree",
    "claude-cmux-open",
    "claude-sessions",
    "claude-usage",
    "cmux",
    "tmux",
    "route",
    "pipeline",
    "ai-proxy",
    "ttyd",
] as const;

export const PROFILING_DETAIL_VALUES = ["phases", "all"] as const;

export type KnownProfilerScope = (typeof PROFILER_SCOPE_NAMES)[number];

/**
 * Derived from the array, never written out twice. A hand-written union drifts
 * silently: `satisfies readonly ProfilingDetail[]` rejects an array entry that
 * is not in the union, but nothing catches a union member missing from the
 * array, so `--detail` would stop offering a value that still typechecks
 * everywhere (PR #343 review t13).
 */
export type ProfilingDetail = (typeof PROFILING_DETAIL_VALUES)[number];
