/**
 * The files that spell the harness set outside the drivers, with how many lists, tables and branches each may
 * keep (`scripts/ci/harness-guard.ts`). Written by `bun scripts/ci/harness-guard.ts --write-allowlist`. It may
 * only shrink: a phase of `.claude/plans/2026-10-30-PlugenizeHarnesses.md` that moves a site into its driver
 * lowers the count here in the same commit. The inventory with the part letter of each site is the plan note
 * `GenesisTools/2026-10-08-PlugenizeTheHarnesses.plan.md` (section of 2026-10-30).
 *
 * An entry whose sites are deliberately not a harness fact (an upstream-route axis, a standalone plugin copy that
 * cannot import the package) says why in `why`, one line; the writer keeps it. `--strict` fails on an entry
 * without one, so the list ends as the justified entries only (plan P8).
 */
export interface HarnessGuardCounts {
    list?: number;
    table?: number;
    branch?: number;
    why?: string;
}

export const HARNESS_GUARD_ALLOWLIST: Readonly<Record<string, HarnessGuardCounts>> = {
    "plugins/genesis-tools/hooks/agents-talk-hint.ts": {
        branch: 2,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "plugins/genesis-tools/hooks/area-rules.ts": {
        branch: 1,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "plugins/genesis-tools/hooks/harness.ts": {
        list: 1,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "plugins/genesis-tools/hooks/record-session-account.ts": {
        branch: 6,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "plugins/genesis-tools/hooks/record-session-cmux.ts": {
        branch: 2,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "plugins/genesis-tools/hooks/track-session-files.ts": {
        branch: 1,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "plugins/genesis-tools/lib/agent-process.ts": {
        list: 1,
        table: 2,
        branch: 1,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "plugins/genesis-tools/lib/resume-argv.ts": {
        branch: 2,
        why: "a standalone plugin hook: the harness copies plugins/** out of the checkout, so it cannot import the drivers (check-plugin-standalone.ts)",
    },
    "scripts/benchmarks/fs/walk-trees.ts": {
        table: 1,
        why: "benchmark tree names a baseline records (claude-listing, claude-all, grok, codex), not the harness set",
    },
    "src/agents/commands/hooks.ts": {
        table: 2,
        why: "HOOK_INSTALLERS, the agents tool's one table of hook-file installers (they write settings.json and hooks.json, which the tool owns); Grok runs Claude's hooks and has no entry",
    },
    "src/agents/lib/hooks/config.ts": {
        table: 6,
        why: "the user's per-harness hook config shape (guard, diff and question overrides keyed by HarnessName), read from hooks.json; its defaults come from the drivers' hooks parts",
    },
    "src/agents/lib/hooks/diff/theme.ts": {
        branch: 1,
        why: "a DiffThemeName: the theme named claude follows Claude Code's own /theme, it is no harness",
    },
    "src/agents/lib/hooks/harnesses.ts": {
        table: 2,
        why: "the result type of lastSeenPerHarness, keyed by the canonical harness type and filled from HARNESS_NAMES; no fact of its own",
    },
    "src/agents/lib/hooks/payload.ts": {
        table: 1,
        why: "the declared type of HARNESS_HOOK_FACTS, which byHarness builds from the drivers' hooks parts through harness-hooks.ts",
    },
    "src/ai-proxy/commands/session-use.ts": {
        list: 1,
        why: "the ai-proxy upstream-route axis (which upstream answers a request), not the coding-agent harness of a session (plan decision G5)",
    },
    "src/ai-proxy/lib/providers/upstream-failure.ts": {
        table: 1,
        why: "the ai-proxy upstream-route axis (which upstream answers a request), not the coding-agent harness of a session (plan decision G5)",
    },
    "src/ai-proxy/lib/sessions/records.ts": {
        list: 1,
        table: 2,
        why: "the ai-proxy upstream-route axis (which upstream answers a request), not the coding-agent harness of a session (plan decision G5)",
    },
    "src/ai-proxy/lib/sessions/routing.ts": {
        list: 1,
        why: "the ai-proxy upstream-route axis (which upstream answers a request), not the coding-agent harness of a session (plan decision G5)",
    },
    "src/ai-proxy/lib/sessions/settings.ts": {
        table: 1,
        why: "an exhaustive mapped type over the upstream providers of a Claude Code session (ClaudeCodeProvider), the ai-proxy route axis (plan decision G5)",
    },
    "src/ai-proxy/lib/sessions/view.ts": {
        list: 1,
        why: "the ai-proxy upstream-route axis (which upstream answers a request), not the coding-agent harness of a session (plan decision G5)",
    },
    "src/ai-spend/lib/drivers/index.ts": {
        table: 1,
        why: "the one tool-owned spend table (SPEND_DRIVERS) that every driver's spend part names: MonitorDriver reads ai-spend's own parsers and pricing",
    },
    "src/ai-spend/lib/reports/types.ts": {
        list: 1,
        table: 3,
        why: "keyed by SourceId, ccusage's report-source axis (17 sources, three of them harnesses), whose rows mirror ccusage's CLI per source (parity.test.ts)",
    },
    "src/ai-spend/lib/workers/sessions.ts": {
        table: 1,
        why: "the worker store readers in listing order; they import the worker tools' stores (@app/codex, @app/grok, @app/claude), which the spend table must not load",
    },
    "src/ai/commands/statusline/run.ts": {
        table: 1,
        why: "the statusline host table (HOST_FEATURES) that the drivers' pending statusline part names: the hot entry imports the Claude feature itself, so a render pays no driver hop",
    },
    "src/ai/lib/agent-message/delivery.ts": {
        table: 2,
        why: "the one table of the message part: each MessageDriver is this tool's code (peer channel, thread queue, Grok leader), which src/utils cannot import",
    },
    "src/ai/lib/sessions/agent-session-rows.ts": {
        table: 1,
        why: "ROW_LISTERS, the one tool-owned session-row table: Claude's listing and the cache clocks are the claude tool's (@app/claude/lib/usage/session-rows), which a driver cannot import",
    },
    "src/cmux/lib/session-agents.ts": {
        table: 2,
        why: "the one tool-owned cmux table (CmuxAdapter) that every driver's cmux part names: its launch extras need the cmux and grok tools, which @genesiscz/utils cannot import",
    },
    "src/genesis-tools-mcp/lib/http-caller.ts": {
        table: 1,
        why: "SESSION_ID_OF, keyed by the gateway's runtime-agent caller axis (with copilot and unknown); its readers spawn lsof and read the session registry, which the hook-path drivers must not load",
    },
    "src/hub/lib/agents/index.ts": {
        table: 1,
        why: "the one table of the tool-owned subagents part that every driver names this file for: a parent is built from the hub's own agent records and workers",
    },
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/ToolCalls/SessionNativeLog.swift": {
        branch: 3,
        why: "the Swift format owner of the Claude and Codex transcript lines it indexes (the TS readers' counterpart): the bytes of a line pick the indexer, not the harness set",
    },
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/LiveWidgetView.swift": {
        branch: 1,
        why: "the decision log's delivery channels (DeliveryChannel in src/question/lib/decisions/deliver.ts), a route axis: codex is the Codex worker route",
    },
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubInbox.swift": {
        branch: 2,
        why: "the decision log's delivery channels (DeliveryChannel in src/question/lib/decisions/deliver.ts), a route axis: codex is the Codex worker route",
    },
    "src/mcp-manager/utils/harnesses.ts": {
        table: 1,
        why: "the MCP-client axis (Gemini and Cursor too) of the tool-owned mcp part: each client's stored default config home",
    },
    "src/question/lib/decisions/deliver.ts": {
        table: 1,
        why: "ANSWER_ROUTES, the one table of the tool-owned answer part that every driver names (src/question owns the delivery ladder; @genesiscz/utils cannot import it)",
    },
    "src/utils/agent-sessions/readers/codex-import.ts": {
        branch: 1,
        why: "the Codex importer's own precondition, in the Codex reader files beside the other readers: another harness's session is refused",
    },
    "src/utils/agent-sessions/search.ts": {
        table: 1,
        why: "the SearchAdapters map type, filled from the canonical list (SEARCH_PROVIDERS); it holds no fact per harness",
    },
    "src/utils/cli/failures/caller.ts": {
        table: 1,
        why: "CALLER_TRANSCRIPTS, keyed by the caller's runtime agent (with copilot and unknown); it joins the caller's own env and cwd, so a failed run skips the locate part's folder walk",
    },
    "src/utils/env/envVariables.ts": {
        table: 1,
        why: "a false positive: the env accessor object has get/has/isFlag members, not harness names",
    },
    "src/utils/providers/session-paths.ts": {
        table: 2,
        why: "the native-home lint owner: the home folder names may appear only here, so the per-harness NativeHomeLayout objects and their exhaustive table stay in this file",
    },
    "src/utils/rm/aside.ts": {
        table: 1,
        why: "keyed by the runtime agent of the caller (claude-code, codex, grok, copilot), a wider set than the harnesses",
    },
    "src/utils/worker/capabilities.ts": {
        table: 1,
        why: "the declared type of WORKER_CAPABILITIES, which byHarness builds from the drivers' worker parts",
    },
};
