import { importNativeCodexSession } from "@genesiscz/utils/ai/openai/native-session-import";
import { nativeSessionRoots, nativeSessionRootsWithLegacyHomes } from "@genesiscz/utils/providers/session-paths";
import { readCompatibilityTranscript } from "./reader-compat";
import { createClaudeHistoryOperations } from "./readers/claude";
import { discoverClaudeHistorySources } from "./readers/claude-discovery";
import { readClaudeStatistics } from "./readers/claude-statistics";
import { createCodexHistoryOperations } from "./readers/codex";
import { discoverCodexHistorySources } from "./readers/codex-discovery";
import { readCodexStatistics } from "./readers/codex-statistics";
import { createGrokHistoryOperations } from "./readers/grok";
import { discoverGrokHistorySources } from "./readers/grok-discovery";
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
    searchMetadata: true,
    ...createGrokHistoryOperations(),
    readStatistics: readGrokStatistics,
});
