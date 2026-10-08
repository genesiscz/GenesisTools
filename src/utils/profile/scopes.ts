/** Scope names tools already pass to `profiler.scope()`. `--scopes` help lists these. */
export const PROFILER_SCOPE_NAMES = [
    // One line per `tools` command run (runTool): wall time from process start, CPU, peak memory, caller.
    "cli",
    "claude-history",
    "agent-sessions",
    "agent-history",
    "codex-run",
    "codex-account",
    "du",
    "du.engine",
    "du.bun",
    "du.ffi",
    "du.cli",
    "clones",
    "teams",
    "hub-agents",
    // `tools hub pr *` phases; with spawn, forge-http and cache below, the hub's PR calls end to end.
    "hub-pr",
    // Every child process an Executor runs (git, gh, glab), with its exit code.
    "spawn",
    // Every GitHub (octokit) and GitLab HTTP request: method, URL without credentials, status.
    "forge-http",
    // Every `cached()` lookup: hit, or miss and why.
    "cache",
    "claude-cmux-tree",
    "claude-cmux-open",
    "claude-sessions",
    "claude-usage",
    // `tools ai-spend`: pricing, per-source transcript loading, aggregation and rendering.
    "ai-spend",
    "cmux",
    "tmux",
    "route",
    "pipeline",
    "ai-proxy",
    "ttyd",
    "ts",
    "macos-mail",
    "chrome-devtools",
    "jev-listen",
    "jev-route",
    "jev-compact",
    "jev-observe",
    "jev-loop",
    "jev-watch",
    "jev-verify",
    "jev-browser",
    "jev-arena",
    "jev-experiment",
    "jev-evaluate",
    "jev-probably",
    "jev-grep",
    "repo-context",
    "control-native",
    "control-overlay",
    "control-simulator",
    "stt",
    "tts",
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
