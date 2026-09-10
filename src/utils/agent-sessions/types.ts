import type { DailyStats, HistoryFileStatistics, SessionMetadataRecord, TokenUsage } from "./cache-types";

export type AgentKind = "claude" | "grok" | "codex";

export interface AgentSession<Kind extends string = AgentKind> {
    kind: Kind;
    sessionId: string;
    cwd: string;
    title: string;
    summary?: string;
    prompt?: string;
    mtime: Date;
    filePath: string;
    project?: string;
    projectDirectory?: string;
    /**
     * Only ever set by a caller that knows the account out of band, such as a cmux pin. It is
     * never populated from the index: the shared engine refuses to infer historical account
     * ownership from whichever account happens to be logged in now, so an unset value means
     * "unknown", not "none".
     */
    account?: string | null;
    /** Canonical native home, independent of whichever account is logged in now. */
    sourceHome?: string;
    /** Provider + session id + canonical source home; stable across rollout moves. */
    sourceKey?: string;
    archived?: boolean;
    isSubagent?: boolean;
    createdAt?: Date;
    gitBranch?: string;
}

export interface AgentSearchFilters {
    query?: string;
    /** Absolute working directory; compared exactly. */
    cwd?: string;
    /** Project leaf name (the last path segment of the cwd); compared exactly. */
    project?: string;
    all?: boolean;
    since?: Date;
    until?: Date;
    limit?: number;
    exact?: boolean;
    regex?: boolean;
    file?: string;
    files?: string[];
    tool?: string;
    context?: number;
    summaryOnly?: boolean;
    /**
     * "Conversation topics" means the sessions that have one: keep only rows with a summary or a
     * custom title, BEFORE the limit is applied, so a topic listing is not filled with
     * first-prompt fallbacks while titled conversations fall off the end.
     */
    titledOnly?: boolean;
    agentsOnly?: boolean;
    excludeAgents?: boolean;
    excludeThinking?: boolean;
    excludeSessions?: string[];
    commitHash?: string;
    commitMessage?: string;
    conversationDate?: Date;
    conversationDateUntil?: Date;
    sortByRelevance?: boolean;
    signal?: AbortSignal;
    /** Limits a cached search to the adapter's configured native roots. */
    sourceRoots?: string[];
}

export interface AgentSearchHit<Kind extends string = AgentKind> extends AgentSession<Kind> {
    matchedText?: string;
    matchedEntries?: NativeHistoryEntry[];
    contextEntries?: NativeHistoryEntry[];
    relevanceScore?: number;
    sourceRecords?: NativeSourceRecord[];
}

export interface AgentSessionAdapter<Kind extends string = AgentKind> {
    kind: Kind;
    list(filters: AgentSearchFilters): Promise<AgentSession<Kind>[]>;
    /** What is already indexed, with no discovery, sync or write. Empty when nothing is indexed. */
    listCached?(filters: AgentSearchFilters): Promise<AgentSession<Kind>[]>;
    /** Indexed sessions still carrying the identity the one-way migration synthesized. */
    unresolvedIdentities?(): Promise<number>;
    search(filters: AgentSearchFilters): Promise<AgentSearchHit<Kind>[]>;
    sync?(options?: { rebuild?: boolean; signal?: AbortSignal }): Promise<NativeIndexSyncResult>;
    /** Aggregate pass; separate from `sync`, which only refreshes metadata. */
    refreshStatistics?(options?: { force?: boolean; signal?: AbortSignal }): Promise<{ coverage: string }>;
    status?(): Promise<NativeIndexStatus>;
}

export interface NativeHistoryEntry {
    line: number;
    role: "user" | "assistant" | "tool" | "thinking" | "system";
    text: string;
    /** Canonical flattened tool values for phrase matching; original text remains available. */
    searchText?: string;
    tool?: string;
    toolEvent?: "call" | "result";
    /** Call input values only; file filters must not mistake result prose for an input. */
    inputText?: string;
    paths: string[];
    commits: string[];
    timestamp?: string;
}

export interface NativeSourceIssue {
    path: string;
    message: string;
    code?: "root-missing";
}
export interface NativeSessionSource<Kind extends string = AgentKind> {
    kind: Kind;
    root: string;
    sourceHome: string;
    filePath: string;
    dataPaths: string[];
    metadataPaths: string[];
    /** Raw text sources that can conservatively prefilter this session without false negatives. */
    searchPaths?: string[];
    /** Optional telemetry inputs used only by explicit statistics refresh, including absent paths. */
    statisticsPaths?: string[];
    /** Relevant per-thread metadata/projection signature, avoiding whole-home invalidation. */
    metadataFingerprint?: string;
    metadata?: Partial<AgentSession<Kind>>;
}
export interface NativeSourceRecord {
    line: number;
    data: string;
}
export interface NativeTranscript<Kind extends string = AgentKind> {
    session: AgentSession<Kind>;
    entries: NativeHistoryEntry[];
    issues: NativeSourceIssue[];
    records?: NativeSourceRecord[];
}
export interface NativeSessionImportContext {
    targetHome: string;
    nativeClient?: { request<T>(method: string, params?: unknown): Promise<T> };
}
export interface NativeSessionImportResult {
    sessionId: string;
    sourceSessionId: string;
    targetHome: string;
    copied: boolean;
}

export type BoundedMetadataField =
    | "customTitle"
    | "summary"
    | "firstPrompt"
    | "allUserText"
    | "firstTimestamp"
    | "lastTimestamp";

/** Compact source metadata. Original content remains behind the reader's record locators. */
export interface HistoryMetadataRecord extends SessionMetadataRecord {
    providerId: string;
    sourceKey: string;
    sourceHome: string;
    nativeId: string;
    parentNativeId?: string;
    root: string;
    projectDirectory?: string;
    lastTimestamp?: string;
    archived: boolean;
    resumeMode: "native" | "unsupported";
    boundedFields: BoundedMetadataField[];
    /** Actual storage byte cuts, separate from intentional corpus/window bounds. */
    storageTruncatedFields?: BoundedMetadataField[];
}

export interface HistoryMetadataRead {
    metadata: Omit<HistoryMetadataRecord, "providerId" | "sourceKey"> | null;
    issues: NativeSourceIssue[];
    complete: boolean;
}

/** Zero-based dense position among valid original records, including records with no searchable entries. */
export interface HistorySourceRecord {
    position: number;
    /** Opaque to the shared engine; resolved only by this source's reader. */
    locator: string;
    timestamp?: string;
    role?: NativeHistoryEntry["role"];
    metadataChanges?: {
        sessionId?: string;
        customTitle?: string;
        summary?: string;
        gitBranch?: string;
        cwd?: string;
    };
    entries: NativeHistoryEntry[];
    original: string;
}

export interface HistoryRecordRead {
    records: HistorySourceRecord[];
    issues: NativeSourceIssue[];
    complete: boolean;
}

export interface HistoryStatisticsRead {
    summary: HistoryFileStatistics;
    /** Exact event-date token buckets for uncached compatibility facades; persisted daily contributions keep provider semantics. */
    dailyTokens?: Record<string, TokenUsage>;
    days: Array<Omit<DailyStats, "tokenUsage"> & { tokenUsage: DailyStats["tokenUsage"] | null }>;
    issues: NativeSourceIssue[];
    complete: boolean;
}

export interface HistoryReadOptions {
    signal?: AbortSignal;
    /** readMetadata only: transient full summary fields for source-backed query fallback; never stored uncapped. */
    fullSummaryFields?: boolean;
    /** Streaming scans report skipped records so callers can expose incomplete results. */
    onIssue?: (issue: NativeSourceIssue) => void;
}

export interface HistoryDiscoveryOptions {
    excludeAgents?: boolean;
    agentsOnly?: boolean;
    project?: string;
    signal?: AbortSignal;
}

export interface NativeSessionReader<Kind extends string = AgentKind> {
    importSession?(
        session: AgentSession<Kind>,
        context: NativeSessionImportContext
    ): Promise<NativeSessionImportResult>;
    kind: Kind;
    parserVersion: string;
    /** Native title/summary metadata may contain searchable text absent from original conversation records. */
    searchMetadata?: boolean;
    /** Compact operations are enabled as provider extraction completes. */
    readMetadata?(source: NativeSessionSource<Kind>, options?: HistoryReadOptions): Promise<HistoryMetadataRead>;
    scan?(source: NativeSessionSource<Kind>, options?: HistoryReadOptions): AsyncIterable<HistorySourceRecord>;
    readRecords?(
        source: NativeSessionSource<Kind>,
        options: HistoryReadOptions & { locators: string[] }
    ): Promise<HistoryRecordRead>;
    readStatistics?(source: NativeSessionSource<Kind>, options?: HistoryReadOptions): Promise<HistoryStatisticsRead>;
    roots(): string[];
    discover(
        roots: string[],
        options?: HistoryDiscoveryOptions
    ): Promise<{
        sources: NativeSessionSource<Kind>[];
        issues: NativeSourceIssue[];
        completeRoots: string[];
        /**
         * Files that exist on disk but were deliberately dropped in favour of another copy of the
         * same session (Claude's per-project duplicates). The sync removes their index rows: a
         * row nobody re-reads keeps its pre-index identity forever and counts as unresolved.
         */
        displaced?: string[];
    }>;
    read(source: NativeSessionSource<Kind>, signal?: AbortSignal): Promise<NativeTranscript<Kind>>;
}
export interface NativeIndexStatus {
    initialized?: boolean;
    sessions: number;
    messages: number | null;
    sources: number;
    issues: NativeSourceIssue[];
}
export interface NativeIndexSyncResult extends NativeIndexStatus {
    parsed: number;
    unchanged: number;
    removed: number;
}
