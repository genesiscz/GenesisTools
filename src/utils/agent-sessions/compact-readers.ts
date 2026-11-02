import { deferredReadChanges, deferredWindowTurns } from "@genesiscz/utils/harness/deferred";
import { nativeSessionRoots, nativeSessionRootsWithLegacyHomes } from "@genesiscz/utils/providers/session-paths";
import { readCompatibilityTranscript } from "./reader-compat";
import { createClaudeHistoryOperations } from "./readers/claude";
import { claudeDialog } from "./readers/claude-dialog";
import { discoverClaudeHistorySources } from "./readers/claude-discovery";
import { claudeClassifyPath } from "./readers/claude-paths";
import { readClaudeStatistics } from "./readers/claude-statistics";
import { createCodexHistoryOperations } from "./readers/codex";
import { discoverCodexHistorySources } from "./readers/codex-discovery";
import { importNativeCodexSession } from "./readers/codex-import";
import { codexClassifyPath } from "./readers/codex-locate";
import { readCodexStatistics } from "./readers/codex-statistics";
import { createGrokHistoryOperations } from "./readers/grok";
import { grokDialog } from "./readers/grok-dialog";
import { discoverGrokHistorySources, grokClassifyPath } from "./readers/grok-discovery";
import { readGrokStatistics } from "./readers/grok-statistics";
import type { AgentKind, NativeSessionReader } from "./types";

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
    windowTurns: deferredWindowTurns(import.meta, "./readers/claude-window-turns", "claudeWindowTurns"),
    roots: () => nativeSessionRoots("claude"),
    discover: discoverClaudeHistorySources,
    classifyPath: claudeClassifyPath,
    readChanges: deferredReadChanges(import.meta, "./readers/claude-changes", "claudeSessionChanges"),
    // One JSONL row per record, and a record's text reads only that row (a tool result's name,
    // which comes from an earlier row, never enters the searched text).
    lineLocalRecords: true,
    ...createClaudeHistoryOperations(),
    readStatistics: readClaudeStatistics,
});

export const codexHistoryReader = createCompactHistoryReader({
    kind: "codex",
    // Codex rollouts do not persist the app-server's live permission prompts.
    dialog: {
        eventLogPath: () => null,
        openPermission: () => null,
        sessionAlive: () => null,
        registryDirectory: () => null,
    },
    windowTurns: deferredWindowTurns(import.meta, "./readers/codex-turns", "codexNativeLinesToTurns"),
    roots: () => nativeSessionRootsWithLegacyHomes("codex"),
    discover: discoverCodexHistorySources,
    classifyPath: codexClassifyPath,
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
    windowTurns: deferredWindowTurns(import.meta, "../ai/transcripts/grok", "grokNativeLinesToTurns"),
    roots: () => nativeSessionRoots("grok"),
    discover: discoverGrokHistorySources,
    classifyPath: grokClassifyPath,
    // No Grok transcript parser reads file changes: a Grok session is judged from the change log alone.
    readChanges: () => null,
    searchMetadata: true,
    ...createGrokHistoryOperations(),
    readStatistics: readGrokStatistics,
});
