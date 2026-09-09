import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { sourceFingerprint } from "./fingerprint";
import { historySourceKey } from "./identity";
import type {
    AgentKind,
    AgentSession,
    HistoryMetadataRecord,
    HistorySourceRecord,
    NativeHistoryEntry,
    NativeSessionReader,
    NativeSessionSource,
    NativeSourceIssue,
    NativeTranscript,
} from "./types";
import { isWrapperUserText } from "./user-text";

interface CompatibilityReadOptions {
    signal?: AbortSignal;
    maxRecords?: number;
    readMetadata?: boolean;
}

function validDate(value: string | null | undefined): Date | undefined {
    if (!value) {
        return;
    }

    const result = new Date(value);
    return Number.isNaN(result.getTime()) ? undefined : result;
}

function originalLine(record: HistorySourceRecord): number {
    const physical = record.locator.match(/^jsonl:(\d+)$/)?.[1];
    return physical ? Number(physical) : record.position + 1;
}

function firstPrompt(entries: NativeHistoryEntry[]): string | undefined {
    return entries.find((entry) => entry.role === "user" && !isWrapperUserText(entry.text))?.text;
}

function appendIssue(issues: NativeSourceIssue[], issue: NativeSourceIssue): void {
    if (!issues.some((candidate) => candidate.path === issue.path && candidate.message === issue.message)) {
        issues.push(issue);
    }
}

function metadataSession<Kind extends AgentKind>(options: {
    kind: Kind;
    source: NativeSessionSource<Kind>;
    metadata?: Omit<HistoryMetadataRecord, "providerId" | "sourceKey">;
    entries: NativeHistoryEntry[];
    records: HistorySourceRecord[];
    fileMtime: Date;
}): AgentSession<Kind> {
    const { kind, source, metadata, entries, records, fileMtime } = options;
    const sourceMetadata = source.metadata ?? {};
    const fallbackId = basename(source.filePath, ".jsonl");
    const isSubagent = metadata?.isSubagent ?? sourceMetadata.isSubagent ?? false;
    const sessionId =
        kind === "claude" && isSubagent
            ? fallbackId
            : (metadata?.sessionId ?? metadata?.nativeId ?? sourceMetadata.sessionId ?? fallbackId);

    if (!sessionId) {
        throw new Error("No native session identity in source");
    }

    const prompt = firstPrompt(entries) ?? metadata?.firstPrompt;
    const cwd = metadata?.cwd ?? sourceMetadata.cwd ?? "";
    let firstRecordDate: Date | undefined;
    let lastRecordDate: Date | undefined;
    for (const record of records) {
        const candidate = validDate(record.timestamp);
        if (!candidate) {
            continue;
        }

        if (!firstRecordDate || candidate < firstRecordDate) {
            firstRecordDate = candidate;
        }
        if (!lastRecordDate || candidate > lastRecordDate) {
            lastRecordDate = candidate;
        }
    }
    let mtime = metadata ? new Date(metadata.mtime) : sourceMetadata.mtime;
    if (mtime && Number.isNaN(mtime.getTime())) {
        mtime = undefined;
    }
    if (sourceMetadata.mtime && (!mtime || sourceMetadata.mtime > mtime)) {
        mtime = sourceMetadata.mtime;
    }
    if (lastRecordDate && (!mtime || lastRecordDate > mtime)) {
        mtime = lastRecordDate;
    }
    mtime ??= fileMtime;
    const createdAt = validDate(metadata?.firstTimestamp) ?? sourceMetadata.createdAt ?? firstRecordDate;
    const title = metadata?.customTitle ?? sourceMetadata.title ?? prompt?.split("\n")[0]?.slice(0, 120) ?? sessionId;
    const summary = metadata?.summary ?? sourceMetadata.summary ?? undefined;
    const project = metadata?.project ?? sourceMetadata.project ?? cwd.split(/[\\/]/).filter(Boolean).pop();

    return {
        kind,
        sessionId,
        cwd,
        title,
        ...(summary ? { summary } : {}),
        ...(prompt ? { prompt } : {}),
        mtime,
        ...(createdAt ? { createdAt } : {}),
        filePath: source.filePath,
        sourceHome: source.sourceHome,
        sourceKey:
            sourceMetadata.sourceKey ??
            historySourceKey({
                providerId: PROVIDER_ALIASES[kind] ?? kind,
                nativeId: metadata?.nativeId ?? sessionId,
                sourceHome: source.sourceHome,
            }),
        archived: metadata?.archived ?? sourceMetadata.archived ?? false,
        isSubagent,
        ...((metadata?.gitBranch ?? sourceMetadata.gitBranch)
            ? { gitBranch: metadata?.gitBranch ?? sourceMetadata.gitBranch }
            : {}),
        ...(project ? { project } : {}),
        ...((metadata?.projectDirectory ?? sourceMetadata.projectDirectory)
            ? { projectDirectory: metadata?.projectDirectory ?? sourceMetadata.projectDirectory }
            : {}),
        ...(sourceMetadata.account === undefined ? {} : { account: sourceMetadata.account }),
    };
}

export async function readCompatibilityTranscript<Kind extends AgentKind>(
    reader: NativeSessionReader<Kind>,
    source: NativeSessionSource<Kind>,
    options: CompatibilityReadOptions = {}
): Promise<NativeTranscript<Kind>> {
    if (!reader.scan) {
        throw new Error(`${reader.kind} history reader does not expose source records`);
    }

    const revision = sourceFingerprint({
        source,
        parserVersion: reader.parserVersion,
        fullMetadataSnapshot: true,
    });
    const issues: NativeSourceIssue[] = [];
    let metadata: Omit<HistoryMetadataRecord, "providerId" | "sourceKey"> | undefined;
    if (options.readMetadata !== false) {
        if (!reader.readMetadata) {
            throw new Error(`${reader.kind} history reader does not expose metadata`);
        }

        const result = await reader.readMetadata(source, { signal: options.signal });
        for (const issue of result.issues) {
            appendIssue(issues, issue);
        }
        metadata = result.metadata ?? undefined;
        if (!metadata) {
            throw new Error("No native session identity in source");
        }
    }

    const records: HistorySourceRecord[] = [];
    const entries: NativeHistoryEntry[] = [];
    const recordLimit = options.maxRecords === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.maxRecords);
    if (recordLimit > 0) {
        for await (const record of reader.scan(source, {
            signal: options.signal,
            onIssue: (issue) => appendIssue(issues, issue),
        })) {
            records.push(record);
            entries.push(...record.entries);
            if (records.length >= recordLimit) {
                break;
            }
        }
    }

    const fileMtime = new Date((await stat(source.filePath)).mtimeMs);
    if (
        sourceFingerprint({
            source,
            parserVersion: reader.parserVersion,
            fullMetadataSnapshot: true,
        }) !== revision
    ) {
        throw new Error("Source changed during compatibility read; retry the request");
    }
    return {
        session: metadataSession({
            kind: reader.kind,
            source,
            metadata,
            entries,
            records,
            fileMtime,
        }),
        entries,
        issues,
        records: records.map((record) => ({ line: originalLine(record), data: record.original })),
    };
}
