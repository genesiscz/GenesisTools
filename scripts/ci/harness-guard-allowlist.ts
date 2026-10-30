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
    "scripts/benchmarks/agent-sessions/discover-child.ts": { list: 1 },
    "scripts/benchmarks/fs/walk-trees.ts": { table: 1 },
    "scripts/benchmarks/widget/roster.ts": { list: 1 },
    "scripts/history/corpus-rehearsal.ts": { list: 2 },
    "src/agents/commands/hooks.ts": { list: 1, table: 2 },
    "src/agents/lib/changes/blame.ts": { table: 2 },
    "src/agents/lib/hooks/config.ts": { table: 9 },
    "src/agents/lib/hooks/diff/theme.ts": { branch: 1 },
    "src/agents/lib/hooks/harnesses.ts": { table: 2 },
    "src/agents/lib/hooks/payload.ts": { table: 2 },
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
    "src/ai-spend/lib/accounts-context.ts": { table: 3 },
    "src/ai-spend/lib/drivers/types.ts": { table: 2 },
    "src/ai-spend/lib/events-cache.ts": { table: 1 },
    "src/ai-spend/lib/monitor.ts": { table: 6 },
    "src/ai-spend/lib/reports/load.ts": { table: 1 },
    "src/ai-spend/lib/reports/native.ts": { table: 2 },
    "src/ai-spend/lib/reports/types.ts": { list: 1, table: 3 },
    "src/ai-spend/lib/series.ts": { table: 1 },
    "src/ai-spend/lib/workers/sessions.ts": { list: 1 },
    "src/ai-spend/lib/workers/stats.ts": { table: 2 },
    "src/ai/commands/statusline/run.ts": { branch: 1 },
    "src/ai/lib/agent-message/delivery.ts": { table: 2 },
    "src/ai/lib/sessions/agent-session-rows.ts": { table: 3 },
    "src/ai/lib/sessions/resolve-transcript.ts": { table: 4 },
    "src/claude/commands/codex.ts": { table: 1 },
    "src/cmux/lib/session-agents.ts": {
        table: 2,
        why: "the one tool-owned cmux table (CmuxAdapter) that every driver's cmux part names: its launch extras need the cmux and grok tools, which @genesiscz/utils cannot import",
    },
    "src/codex/lib/process-scan.ts": { branch: 1 },
    "src/control/lib/cursor-context.ts": { table: 1 },
    "src/dev-dashboard/ui/src/components/QaDecisionsTab.tsx": { branch: 1 },
    "src/genesis-tools-mcp/lib/http-caller.ts": { table: 2 },
    "src/grok/lib/process-scan.ts": { branch: 1 },
    "src/handoff/targeting.ts": { list: 1, table: 1 },
    "src/hub/lib/agents/index.ts": { table: 2 },
    "src/hub/lib/composer/dispatch.ts": { branch: 6 },
    "src/hub/lib/widget/context.ts": { table: 2 },
    "src/hub/lib/widget/roster-index.ts": { table: 1 },
    "src/hub/lib/widget/snapshot.ts": { table: 2 },
    "src/macos/GenesisKit/Sources/GenesisKit/Controls/AgentRosterRow.swift": { branch: 2 },
    "src/macos/GenesisKit/Sources/GenesisKit/Providers/AIProviderMark.swift": { branch: 6 },
    "src/macos/GenesisKit/Sources/GenesisKit/Sessions/ToolCalls/SessionNativeLog.swift": { branch: 3 },
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/LiveWidgetView.swift": { branch: 1 },
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/VoiceNotes/WidgetVoiceNotesStore.swift": { list: 1 },
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetCmuxButton.swift": { branch: 1 },
    "src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetFeatureSettings.swift": { list: 1 },
    "src/macos/GenesisTools/Sources/Host/RmApprove.swift": { branch: 1 },
    "src/macos/GenesisTools/Sources/Host/VaultUnlock.swift": { list: 1 },
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubAgents.swift": { branch: 2 },
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubInbox.swift": { list: 1, branch: 2 },
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubLaunch.swift": { list: 1, branch: 5 },
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubSessionDetail.swift": { list: 1, branch: 1 },
    "src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubTranscriptSearch.swift": { list: 1 },
    "src/mcp-manager/commands/config-json.ts": { branch: 1 },
    "src/mcp-manager/lib/gateway/hosted.ts": { list: 1 },
    "src/mcp-manager/utils/harnesses.ts": { list: 1, table: 1 },
    "src/mcp-manager/utils/types.ts": { list: 1 },
    "src/question/commands/inbox.ts": { list: 1 },
    "src/question/lib/decisions/deliver.ts": { list: 2, table: 4, branch: 2 },
    "src/question/lib/decisions/read.ts": { table: 1 },
    "src/question/lib/decisions/store.ts": { table: 1 },
    "src/say/lib/caller.ts": { table: 1 },
    "src/utils/agent-sessions/readers/codex-import.ts": { branch: 1 },
    "src/utils/agent-sessions/search.ts": { table: 1 },
    "src/utils/ai/transcripts/around.ts": { table: 2 },
    "src/utils/ai/transcripts/resolve.ts": { table: 4 },
    "src/utils/ai/transcripts/session-title.ts": { table: 1 },
    "src/utils/cli/failures/caller.ts": { table: 1 },
    "src/utils/env/envVariables.ts": {
        table: 1,
        why: "a false positive: the env accessor object has get/has/isFlag members, not harness names",
    },
    "src/utils/providers/session-paths.ts": {
        table: 2,
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
    "src/utils/worker/capabilities.ts": {
        table: 1,
        why: "the declared type of WORKER_CAPABILITIES, which byHarness builds from the drivers' worker parts",
    },
};
