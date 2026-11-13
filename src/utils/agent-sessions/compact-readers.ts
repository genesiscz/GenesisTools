import { deferredReadChanges, deferredWindowTurns } from "@genesiscz/utils/harness/deferred";
import { nativeSessionRoots, nativeSessionRootsWithLegacyHomes } from "@genesiscz/utils/providers/session-paths";
import { readCompatibilityTranscript } from "./reader-compat";
import { createClaudeHistoryOperations } from "./readers/claude";
import { claudeAnalysis } from "./readers/claude-analysis";
import { claudeDialog } from "./readers/claude-dialog";
import { discoverClaudeHistorySources } from "./readers/claude-discovery";
import { claudeMidWork } from "./readers/claude-mid-work";
import { claudeClassifyPath, claudeReadSpawnLink } from "./readers/claude-paths";
import { readClaudeStatistics } from "./readers/claude-statistics";
import { claudeWorkflows } from "./readers/claude-workflows";
import { createCodexHistoryOperations, readCodexSpawnLink } from "./readers/codex";
import { codexAnalysis } from "./readers/codex-analysis";
import { discoverCodexHistorySources } from "./readers/codex-discovery";
import { importNativeCodexSession } from "./readers/codex-import";
import { codexClassifyPath } from "./readers/codex-locate";
import { codexPendingCall } from "./readers/codex-pending-call";
import { readCodexStatistics } from "./readers/codex-statistics";
import { codexMidWork } from "./readers/codex-turn-state";
import { createGrokHistoryOperations } from "./readers/grok";
import { grokAnalysis } from "./readers/grok-analysis";
import { grokDialog } from "./readers/grok-dialog";
import { discoverGrokHistorySources, grokClassifyPath } from "./readers/grok-discovery";
import { readGrokStatistics } from "./readers/grok-statistics";
import { grokMidWork } from "./readers/grok-turn-state";
import type { AgentKind, NativeSessionReader } from "./types";
import { noWorkflowReader } from "./workflow-types";

type CompactHistoryReaderOptions<Kind extends AgentKind> = Omit<NativeSessionReader<Kind>, "read">;

function createCompactHistoryReader<Kind extends AgentKind>(
    options: CompactHistoryReaderOptions<Kind>
): NativeSessionReader<Kind> {
    const reader: NativeSessionReader<Kind> = {
        ...options,
        read: (source, signal) => readCompatibilityTranscript(reader, source, { signal }),
    };
    return reader;
}

export const claudeHistoryReader = createCompactHistoryReader({
    kind: "claude",
    // Claude permission prompts are delivered through hooks, not a transcript event log.
    dialog: claudeDialog,
    analysis: claudeAnalysis,
    workflows: claudeWorkflows,
    windowTurns: deferredWindowTurns(import.meta, "./readers/claude-window-turns", "claudeWindowTurns"),
    roots: () => nativeSessionRoots("claude"),
    discover: discoverClaudeHistorySources,
    classifyPath: claudeClassifyPath,
    readSpawnLink: claudeReadSpawnLink,
    midWork: claudeMidWork,
    readChanges: deferredReadChanges(import.meta, "./readers/claude-changes", "claudeSessionChanges"),
    // One JSONL row per record, and a record's text reads only that row (a tool result's name,
    // which comes from an earlier row, never enters the searched text).
    lineLocalRecords: true,
    ...createClaudeHistoryOperations(),
    readStatistics: readClaudeStatistics,
});

export const codexHistoryReader = createCompactHistoryReader({
    kind: "codex",
    // Codex rollouts do not persist the app-server's live permission prompts; the pending call is the rollout's own.
    dialog: {
        eventLogPath: () => null,
        openPermission: () => null,
        sessionAlive: () => null,
        registryDirectory: () => null,
        pendingCall: codexPendingCall,
    },
    analysis: codexAnalysis,
    // Codex has no multi-agent run tool: its sub-agents (spawn_agent) are sessions of their own, with no run record.
    workflows: noWorkflowReader(
        "Codex has no workflow tool: a rollout records no multi-agent run, only spawned agent threads."
    ),
    windowTurns: deferredWindowTurns(import.meta, "./readers/codex-turns", "codexNativeLinesToTurns"),
    roots: () => nativeSessionRootsWithLegacyHomes("codex"),
    discover: discoverCodexHistorySources,
    classifyPath: codexClassifyPath,
    readSpawnLink: readCodexSpawnLink,
    midWork: codexMidWork,
    readChanges: deferredReadChanges(import.meta, "./readers/codex-changes", "codexSessionChanges"),
    searchMetadata: true,
    // Metadata comes from the first header plus the state sidecars; a record never replays a header.
    scanKeepsMetadata: true,
    ...createCodexHistoryOperations(),
    readStatistics: readCodexStatistics,
    importSession: importNativeCodexSession,
});

export const grokHistoryReader = createCompactHistoryReader({
    kind: "grok",
    dialog: grokDialog,
    analysis: grokAnalysis,
    // Grok CLI has no multi-agent run tool and writes no run record or journal.
    workflows: noWorkflowReader("Grok has no workflow tool: its session folder holds no run record and no journal."),
    windowTurns: deferredWindowTurns(import.meta, "../ai/transcripts/grok", "grokNativeLinesToTurns"),
    roots: () => nativeSessionRoots("grok"),
    discover: discoverGrokHistorySources,
    classifyPath: grokClassifyPath,
    // A Grok sub-agent's `summary.json` names only itself (`agent_id`, `agent_name`, `session_kind`), never its
    // lead, so no Grok file says which session spawned it.
    readSpawnLink: async () => null,
    midWork: grokMidWork,
    // No Grok transcript parser reads file changes: a Grok session is judged from the change log alone.
    readChanges: () => null,
    searchMetadata: true,
    ...createGrokHistoryOperations(),
    readStatistics: readGrokStatistics,
});
