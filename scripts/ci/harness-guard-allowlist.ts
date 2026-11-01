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
    "scripts/benchmarks/fs/walk-trees.ts": {
        table: 1,
        why: "benchmark tree names a baseline records (claude-listing, claude-all, grok, codex), not the harness set",
    },
    "src/agents/lib/hooks/diff/theme.ts": {
        branch: 1,
        why: "a DiffThemeName: the theme named claude follows Claude Code's own /theme, it is no harness",
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
    "src/ai-spend/lib/reports/types.ts": {
        list: 1,
        table: 3,
        why: "keyed by SourceId, ccusage's report-source axis (17 sources, three of them harnesses), whose rows mirror ccusage's CLI per source (parity.test.ts)",
    },
    "src/genesis-tools-mcp/lib/http-caller.ts": {
        table: 1,
        why: "SESSION_ID_OF, keyed by the gateway's runtime-agent caller axis (with copilot and unknown); its readers spawn lsof and read the session registry, which the hook-path drivers must not load",
    },
    "src/ai/lib/embed/registry.ts": {
        table: 2,
        why: "EMBED_LAUNCHERS, the embed tool table keyed by HarnessId: each launcher lives in its agent tool (src/<agent>/lib/embed.ts), which the drivers cannot import",
    },
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/ToolCalls/SessionNativeLog.swift": {
        branch: 3,
        why: "the Swift format owner of the Claude and Codex transcript lines it indexes (the counterpart of the TS readers/, which the guard owns): the bytes of a line pick the indexer; one indexer file per harness is a follow-up that needs a Swift build",
    },
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/DecisionDetails.swift": {
        branch: 1,
        why: "the decision log's delivery channels (DeliveryChannel in src/question/lib/decisions/deliver.ts), a route axis: codex is the Codex worker route",
    },
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/LiveWidgetView.swift": {
        branch: 1,
        why: "the decision log's delivery channels (DeliveryChannel in src/question/lib/decisions/deliver.ts), a route axis: codex is the Codex worker route",
    },
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubInbox.swift": {
        branch: 1,
        why: "the decision log's delivery channels (DeliveryChannel in src/question/lib/decisions/deliver.ts), a route axis: codex is the Codex worker route",
    },
    "src/mcp-manager/utils/harnesses.ts": {
        table: 1,
        why: "the MCP-client axis (Gemini and Cursor too), not the harness set: each client's stored default config home",
    },
    "src/utils/cli/failures/caller.ts": {
        table: 1,
        why: "CALLER_TRANSCRIPTS, keyed by the caller's runtime agent (with copilot and unknown); it joins the caller's own env and cwd, so a failed run skips the locate part's folder walk",
    },
    "src/utils/env/envVariables.ts": {
        table: 1,
        why: "the env accessor namespaces (x, grok, codex, copilot, aiProxy, …): variables grouped by the tool or service that reads them, a wider set than the harnesses",
    },
    "plugins/genesis-tools/hooks/session-scratch.ts": {
        table: 2,
        why: "a standalone plugin copy of AGENT_SCRATCH_DIRS (src/utils/rm/scratch-dirs.ts), which a hook cannot import; a test in src/utils/rm/rm.test.ts pins both to the same folder",
    },
    "src/utils/rm/scratch-dirs.ts": {
        table: 1,
        why: "keyed by the runtime agent of the caller (claude-code, codex, grok, copilot), a wider set than the harnesses",
    },
};
