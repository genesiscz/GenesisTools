import { haystackMatch } from "./match";
import { matchHistoryFilePattern } from "./native-match";
import type { CachedHistoryMetadata } from "./repository";
import { HistoryOccurrenceCounter } from "./search-occurrences";
import { calculateHistoryRelevance } from "./search-rank";
import type {
    AgentSearchFilters,
    HistorySourceRecord,
    NativeHistoryEntry,
    NativeSessionReader,
    NativeSessionSource,
    NativeSourceIssue,
} from "./types";

export interface HistorySourceMatch {
    metadata: CachedHistoryMetadata;
    timestamp: Date;
    firstPrompt?: string;
    matchedLocators: string[];
    contextLocators: string[];
    selectedRecords: HistorySourceRecord[];
    relevanceScore: number;
    matchedText?: string;
    issues: NativeSourceIssue[];
}

export function historyRecordText(entries: NativeHistoryEntry[]): string {
    return entries
        .map((entry) => {
            const text = entry.searchText ?? entry.text;
            return entry.toolEvent === "call" && entry.tool ? `${entry.tool} ${text}` : text;
        })
        .join(" ");
}

export function matchesHistoryMetadata(metadata: CachedHistoryMetadata, filters: AgentSearchFilters): boolean {
    return Boolean(
        filters.query &&
            [metadata.nativeId, metadata.customTitle, metadata.summary, metadata.firstPrompt].some(
                (value) => value && haystackMatch(value, filters.query!, filters)
            )
    );
}

function recordMatches(options: {
    record: HistorySourceRecord;
    entries: NativeHistoryEntry[];
    text: string;
    filters: AgentSearchFilters;
}): boolean {
    const { record, entries, text, filters } = options;

    if (filters.query && !haystackMatch(text, filters.query, filters)) {
        return false;
    }

    if (
        filters.tool &&
        !entries.some(
            (entry) => entry.toolEvent === "call" && entry.tool?.toLowerCase().includes(filters.tool!.toLowerCase())
        )
    ) {
        return false;
    }

    const patterns = [filters.file, ...(filters.files ?? [])].filter((pattern): pattern is string => Boolean(pattern));
    const calls = entries.filter((entry) => entry.toolEvent === "call");
    const fileText = calls.map((entry) => `${entry.paths.join("\n")}\n${entry.inputText ?? ""}`).join("\n");

    if (patterns.length && !patterns.some((pattern) => matchHistoryFilePattern(fileText, pattern))) {
        return false;
    }

    if (
        filters.commitHash &&
        !entries.some((entry) => {
            const requested = filters.commitHash!.toLowerCase();
            return entry.commits.some((hash) => {
                const recorded = hash.toLowerCase();
                return recorded.startsWith(requested) || requested.startsWith(recorded);
            });
        })
    ) {
        return false;
    }

    const stamp = record.timestamp ?? entries.find((entry) => entry.timestamp)?.timestamp;

    if (stamp) {
        const date = new Date(stamp);

        if ((filters.since && date < filters.since) || (filters.until && date > filters.until)) {
            return false;
        }
    }

    return true;
}

/** Original record positions drive context, including metadata/progress records with no display entries. */
export async function searchHistorySource(options: {
    source: NativeSessionSource<string>;
    reader: NativeSessionReader<string>;
    metadata: CachedHistoryMetadata;
    filters: AgentSearchFilters;
    now?: Date;
    allowMetadataMatch?: boolean;
    onIssue?: (issue: NativeSourceIssue) => void;
}): Promise<HistorySourceMatch | null> {
    const { source, reader, filters } = options;

    if (!reader.scan) {
        throw new Error(`${reader.kind} does not implement source-backed history scanning`);
    }

    const metadata = { ...options.metadata };
    const issues: NativeSourceIssue[] = [];
    const matchedLocators: string[] = [];
    const contextLocators = new Set<string>();
    const context = Math.max(0, Math.floor(filters.context ?? 0));
    const previous: HistorySourceRecord[] = [];
    const selectedRecords = new Map<string, HistorySourceRecord>();
    const conversationLocators: string[] = [];
    const occurrences = new HistoryOccurrenceCounter(filters.query ?? "");
    let through = -1;
    let timestamp: Date | undefined;
    let firstPrompt: string | undefined;
    let matchedText: string | undefined;
    let recordCount = 0;
    let commitMessageFound = false;

    for await (const record of reader.scan(source, {
        signal: filters.signal,
        onIssue: (issue) => {
            issues.push(issue);
            options.onIssue?.(issue);
        },
    })) {
        filters.signal?.throwIfAborted();
        recordCount++;
        const changes = record.metadataChanges;

        if (changes) {
            metadata.sessionId = changes.sessionId || metadata.sessionId;
            metadata.gitBranch = changes.gitBranch || metadata.gitBranch;
            metadata.cwd = changes.cwd || metadata.cwd;
            metadata.summary = changes.summary ?? metadata.summary;
            metadata.customTitle = changes.customTitle ?? metadata.customTitle;
        }

        const stamp = record.timestamp ?? record.entries.find((entry) => entry.timestamp)?.timestamp;

        if (stamp && !timestamp) {
            timestamp = new Date(stamp);
        }

        if (record.role === "user" && !firstPrompt) {
            firstPrompt = historyRecordText(record.entries.filter((entry) => entry.role !== "thinking"));
        }

        const entries = filters.excludeThinking
            ? record.entries.filter((entry) => entry.role !== "thinking")
            : record.entries;
        const text = historyRecordText(entries);
        occurrences.append(` ${text}`);

        if (filters.commitMessage) {
            if (record.role === "user" || record.role === "assistant") {
                conversationLocators.push(record.locator);
            }

            commitMessageFound ||= entries.some(
                (entry) =>
                    entry.toolEvent === "call" &&
                    entry.inputText?.includes("git commit") &&
                    entry.inputText.toLowerCase().includes(filters.commitMessage!.toLowerCase())
            );
        }

        if (context && record.position <= through) {
            contextLocators.add(record.locator);
            selectedRecords.set(record.locator, record);
        }

        if (recordMatches({ record, entries, text, filters })) {
            matchedLocators.push(record.locator);
            selectedRecords.set(record.locator, record);
            matchedText ??= text.slice(0, 1200);

            if (context) {
                for (const prior of previous) {
                    contextLocators.add(prior.locator);
                    selectedRecords.set(prior.locator, prior);
                }

                contextLocators.add(record.locator);
                through = record.position + context;
            }
        }

        if (context) {
            previous.push(record);

            while (previous.length > context) {
                previous.shift();
            }
        }
    }

    filters.signal?.throwIfAborted();

    const metadataMatch = Boolean(options.allowMetadataMatch && matchesHistoryMetadata(metadata, filters));

    if (
        (recordCount === 0 && !metadataMatch) ||
        filters.excludeSessions?.some(
            (id) => id === metadata.sessionId || id === metadata.nativeId || id === metadata.sourceKey
        )
    ) {
        return null;
    }

    if (
        timestamp &&
        ((filters.conversationDate && timestamp < filters.conversationDate) ||
            (filters.conversationDateUntil && timestamp > filters.conversationDateUntil))
    ) {
        return null;
    }

    if (filters.commitMessage && !commitMessageFound) {
        return null;
    }

    const requiresMatch = Boolean(
        filters.query || filters.tool || filters.file || filters.files?.some(Boolean) || filters.commitHash
    );

    if (!filters.commitMessage && requiresMatch && matchedLocators.length === 0 && !metadataMatch) {
        return null;
    }

    const started =
        timestamp ?? (metadata.firstTimestamp ? new Date(metadata.firstTimestamp) : (options.now ?? new Date()));
    return {
        metadata,
        timestamp: started,
        firstPrompt,
        matchedLocators: filters.commitMessage ? conversationLocators : matchedLocators,
        contextLocators: filters.commitMessage ? [] : [...contextLocators],
        selectedRecords: [...selectedRecords.values()].sort((left, right) => left.position - right.position),
        relevanceScore: calculateHistoryRelevance({
            query: filters.query ?? "",
            customTitle: metadata.customTitle ?? undefined,
            summary: metadata.summary ?? undefined,
            firstUserMessage: firstPrompt,
            allText: "",
            contentScore: occurrences.score,
            timestamp: started,
            now: options.now,
        }),
        matchedText:
            matchedText ??
            (metadataMatch
                ? (metadata.customTitle ?? metadata.summary ?? metadata.firstPrompt ?? "").slice(0, 1200)
                : undefined),
        issues,
    };
}
