import { nativeSessionRoots, nativeSessionRootsWithLegacyHomes } from "@genesiscz/utils/providers/session-paths";
import { readCompatibilityTranscript } from "./reader-compat";
import { createClaudeHistoryOperations } from "./readers/claude";
import { claudeIndexesFile, discoverClaudeHistorySources } from "./readers/claude-discovery";
import { readClaudeStatistics } from "./readers/claude-statistics";
import { createCodexHistoryOperations } from "./readers/codex";
import { codexIndexesFile, discoverCodexHistorySources } from "./readers/codex-discovery";
import { importNativeCodexSession } from "./readers/codex-import";
import { readCodexStatistics } from "./readers/codex-statistics";
import { createGrokHistoryOperations } from "./readers/grok";
import { discoverGrokHistorySources, grokIndexesFile } from "./readers/grok-discovery";
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
    roots: () => nativeSessionRoots("claude"),
    discover: discoverClaudeHistorySources,
    indexesFile: claudeIndexesFile,
    // One JSONL row per record, and a record's text reads only that row (a tool result's name,
    // which comes from an earlier row, never enters the searched text).
    lineLocalRecords: true,
    ...createClaudeHistoryOperations(),
    readStatistics: readClaudeStatistics,
});

export const codexHistoryReader = createCompactHistoryReader({
    kind: "codex",
    roots: () => nativeSessionRootsWithLegacyHomes("codex"),
    discover: discoverCodexHistorySources,
    indexesFile: codexIndexesFile,
    searchMetadata: true,
    // Metadata comes from the first header plus the state sidecars; a record never replays a header.
    scanKeepsMetadata: true,
    ...createCodexHistoryOperations(),
    readStatistics: readCodexStatistics,
    importSession: importNativeCodexSession,
});

export const grokHistoryReader = createCompactHistoryReader({
    kind: "grok",
    roots: () => nativeSessionRoots("grok"),
    discover: discoverGrokHistorySources,
    indexesFile: grokIndexesFile,
    searchMetadata: true,
    ...createGrokHistoryOperations(),
    readStatistics: readGrokStatistics,
});

/**
 * The three native readers, for code that holds a transcript row but not its provider (the failure log names the
 * model of whichever session ran a tool) and must not load the provider registry on its synchronous path. Code that
 * knows the provider asks `resolveHistoryProvider(kind)`.
 */
export const nativeHistoryReaders: readonly NativeSessionReader<AgentKind>[] = [
    claudeHistoryReader,
    codexHistoryReader,
    grokHistoryReader,
];
