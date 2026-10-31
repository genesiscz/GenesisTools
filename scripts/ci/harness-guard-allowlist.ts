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
        why: "a standalone plugin hook (check-plugin-standalone.ts): the harness ids and resume argv come from the generated lib/Generated/harness-facts.ts (scripts/gen-harness-plugin.ts); what is left is per-harness behaviour no driver fact describes yet",
    },
    "plugins/genesis-tools/hooks/area-rules.ts": {
        branch: 1,
        why: "a standalone plugin hook (check-plugin-standalone.ts): the harness ids and resume argv come from the generated lib/Generated/harness-facts.ts (scripts/gen-harness-plugin.ts); what is left is per-harness behaviour no driver fact describes yet",
    },
    "plugins/genesis-tools/hooks/record-session-account.ts": {
        branch: 6,
        why: "a standalone plugin hook (check-plugin-standalone.ts): the harness ids and resume argv come from the generated lib/Generated/harness-facts.ts (scripts/gen-harness-plugin.ts); what is left is per-harness behaviour no driver fact describes yet",
    },
    "plugins/genesis-tools/hooks/record-session-cmux.ts": {
        branch: 2,
        why: "a standalone plugin hook (check-plugin-standalone.ts): the harness ids and resume argv come from the generated lib/Generated/harness-facts.ts (scripts/gen-harness-plugin.ts); what is left is per-harness behaviour no driver fact describes yet",
    },
    "plugins/genesis-tools/hooks/track-session-files.ts": {
        branch: 1,
        why: "a standalone plugin hook (check-plugin-standalone.ts): the harness ids and resume argv come from the generated lib/Generated/harness-facts.ts (scripts/gen-harness-plugin.ts); what is left is per-harness behaviour no driver fact describes yet",
    },
    "plugins/genesis-tools/lib/agent-process.ts": {
        table: 2,
        branch: 1,
        why: "a standalone plugin hook (check-plugin-standalone.ts): the harness ids and resume argv come from the generated lib/Generated/harness-facts.ts (scripts/gen-harness-plugin.ts); what is left is per-harness behaviour no driver fact describes yet",
    },
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
        why: "the MCP-client axis (Gemini and Cursor too), not the harness set: each client's stored default config home",
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
        table: 1,
        why: "the native-home lint owner: the home folder names may appear only here, so the per-harness NativeHomeLayout objects and their exhaustive table stay in this file",
    },
    "src/utils/rm/approval.ts": {
        table: 1,
        why: "keyed by the runtime agent of the caller (claude-code, codex, grok, cursor, gemini), a wider set than the harnesses",
    },
    "src/utils/rm/aside.ts": {
        table: 1,
        why: "keyed by the runtime agent of the caller (claude-code, codex, grok, copilot), a wider set than the harnesses",
    },
};
