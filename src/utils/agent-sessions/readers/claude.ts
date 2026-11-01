import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import { flattenToolInput } from "@genesiscz/utils/agent-sessions/native-content";
import { readJsonlBackward, readJsonlTurnBoundary } from "@genesiscz/utils/agent-sessions/read-backward";
import { readJsonlForward } from "@genesiscz/utils/agent-sessions/read-forward";
import type { JsonRecord, JsonValue } from "@genesiscz/utils/agent-sessions/source-scan";
import { asRecord, blocksMetadata, scanJsonlRecords } from "@genesiscz/utils/agent-sessions/source-scan";
import { isWrapperUserText } from "@genesiscz/utils/agent-sessions/user-text";
import { readLastLines, splitLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { profiler } from "@genesiscz/utils/profile";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { foldJsonlResumable } from "../jsonl-fold";
import { boundHistoryText, HISTORY_METADATA_LIMITS } from "../metadata";
import type {
    BackwardRead,
    BoundedMetadataField,
    ContinuedInOptions,
    ForwardRead,
    HistoryMetadataRead,
    HistoryOperations,
    HistoryReadOptions,
    HistoryRecordRead,
    HistorySourceRecord,
    NativeHistoryEntry,
    NativeSessionSource,
    NativeSourceIssue,
    ReadBackwardOptions,
    ReadForwardOptions,
    RowAnchorWalk,
    TurnBoundary,
} from "../types";
import { claudeCurrentModel } from "./claude-model";
import { scanClaudeNative } from "./claude-native-scan";
import { claudeNativeId, claudeProjectDirectory, claudeProjectName, isClaudeSubagentPath } from "./claude-paths";
import { claudeCustomTitleOfRow } from "./claude-title";
import { anchorRecord, anchorStrings, historyEntryBuilder, type ToolContext } from "./history-entry";

const TOOL_INPUT_FIELD_CAP = 2_000;
const TOOL_INPUT_TOTAL_CAP = 8_000;
const LARGE_METADATA_FILE_BYTES = 10 * 1024 * 1024;
const METADATA_HEAD_RECORDS = 200;
const METADATA_TAIL_BYTES = 64 * 1024;

function asText(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : "";
}

function sourceIssue(path: string, message: string): NativeSourceIssue {
    return { path, message };
}

function userText(row: JsonRecord): string {
    if (row.type !== "user") {
        return "";
    }

    const content = asRecord(row.message).content;
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }

    for (const value of content) {
        const block = asRecord(value);
        if (block.type === "text") {
            return asText(block.text);
        }
    }

    return "";
}

interface ParsedClaudeRow {
    position: number;
    line: number;
    locator: string;
    original: string;
    row: JsonRecord;
}

function nativePaths(input: JsonRecord): string[] {
    const result: string[] = [];
    for (const field of ["file_path", "path", "filePath", "notebook_path"]) {
        const value = asText(input[field]);
        if (value) {
            result.push(value);
        }
    }

    return [...new Set(result)];
}

function parsableTimestamp(value: string): string | null {
    return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function commitHashes(text: string): string[] {
    if (!/git commit|committed|Commit:|^\[[^\]]+\s+[a-f0-9]{7,40}\]|\b[a-f0-9]{7,40}\b\s+\S/im.test(text)) {
        return [];
    }

    return [
        ...new Set(
            (text.match(/\b[a-f0-9]{7,40}\b/gi) ?? []).filter((value) => value.length >= 7 && !/^(.)\1+$/.test(value))
        ),
    ];
}

const historyEntry = historyEntryBuilder(commitHashes);

function contentEntries(options: {
    content: JsonValue | undefined;
    role: NativeHistoryEntry["role"];
    line: number;
    timestamp?: string;
    tools: ToolContext;
}): NativeHistoryEntry[] {
    if (typeof options.content === "string") {
        const entry = historyEntry({
            role: options.role,
            text: options.content,
            line: options.line,
            timestamp: options.timestamp,
        });
        return entry ? [entry] : [];
    }
    if (!Array.isArray(options.content)) {
        return [];
    }

    const entries: NativeHistoryEntry[] = [];
    for (const value of options.content) {
        const block = asRecord(value);
        if (block.type === "text") {
            const entry = historyEntry({
                role: options.role,
                text: asText(block.text),
                line: options.line,
                timestamp: options.timestamp,
            });
            if (entry) {
                entries.push(entry);
            }
        } else if (block.type === "thinking") {
            const entry = historyEntry({
                role: "thinking",
                text: asText(block.thinking),
                line: options.line,
                timestamp: options.timestamp,
            });
            if (entry) {
                entries.push(entry);
            }
        } else if (block.type === "tool_use") {
            const input = asRecord(block.input);
            const tool = asText(block.name);
            const id = asText(block.id);
            const paths = nativePaths(input);
            const inputText = flattenToolInput({
                input,
                fieldLimit: TOOL_INPUT_FIELD_CAP,
                totalLimit: TOOL_INPUT_TOTAL_CAP,
            });
            options.tools.names.set(id, tool);
            options.tools.paths.set(id, paths);
            const entry = historyEntry({
                role: "tool",
                text: SafeJSON.stringify(input, { strict: true }),
                searchText: inputText,
                inputText,
                line: options.line,
                timestamp: options.timestamp,
                tool,
                toolEvent: "call",
                paths,
                callId: id,
            });
            if (entry) {
                entries.push(entry);
            }
        } else if (block.type === "tool_result" && typeof block.content === "string") {
            const id = asText(block.tool_use_id);
            const entry = historyEntry({
                role: "tool",
                text: block.content,
                line: options.line,
                timestamp: options.timestamp,
                tool: options.tools.names.get(id),
                toolEvent: "result",
                paths: options.tools.paths.get(id),
            });
            if (entry) {
                entries.push(entry);
            }
        }
    }

    return entries;
}

/**
 * The name Claude Code gave the session itself: an `ai-title` line (the name its /resume list and the terminal tab
 * show), or the `summary` line older versions wrote. Both are stored as the summary, the newest line winning; a
 * `/rename` (`custom-title`) still comes first. Without `ai-title` the widget listed "Kalendora hotfix research" under
 * its first prompt, and Martin could not find it (2026-10-24).
 */
function autoTitleOf(row: JsonRecord): string {
    return row.type === "ai-title" ? asText(row.aiTitle) : row.type === "summary" ? asText(row.summary) : "";
}

function claudeRecordContext(row: JsonRecord): Pick<HistorySourceRecord, "timestamp" | "role" | "metadataChanges"> {
    const timestamp = asText(row.timestamp) || undefined;
    const role =
        row.type === "user" || row.type === "assistant"
            ? row.type
            : row.type === "queue-operation" ||
                row.type === "summary" ||
                row.type === "ai-title" ||
                row.type === "custom-title"
              ? "system"
              : undefined;
    const sessionId = asText(row.sessionId);
    const customTitle = claudeCustomTitleOfRow(row);
    const summary = autoTitleOf(row);
    const gitBranch = asText(row.gitBranch);
    const cwd = asText(row.cwd);
    const metadataChanges = {
        ...(sessionId ? { sessionId } : {}),
        ...(customTitle ? { customTitle } : {}),
        ...(summary ? { summary } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(cwd ? { cwd } : {}),
    };

    return {
        ...(timestamp ? { timestamp } : {}),
        ...(role ? { role } : {}),
        ...(Object.keys(metadataChanges).length > 0 ? { metadataChanges } : {}),
    };
}

function recordEntries(row: JsonRecord, line: number, tools: ToolContext): NativeHistoryEntry[] {
    const timestamp = asText(row.timestamp) || undefined;
    if (row.type === "user" || row.type === "assistant") {
        return contentEntries({
            content: asRecord(row.message).content,
            role: row.type,
            line,
            timestamp,
            tools,
        });
    }
    if (
        row.type === "queue-operation" ||
        row.type === "summary" ||
        row.type === "ai-title" ||
        row.type === "custom-title"
    ) {
        const text =
            row.type === "summary" || row.type === "ai-title"
                ? autoTitleOf(row)
                : row.type === "custom-title"
                  ? claudeCustomTitleOfRow(row)
                  : asText(row.content);
        const entry = historyEntry({
            role: "system",
            text,
            line,
            timestamp,
        });
        return entry ? [entry] : [];
    }

    return [];
}

function boundedIssue(source: NativeSessionSource<"claude">, category: string, line?: number): NativeSourceIssue {
    return sourceIssue(source.filePath, line === undefined ? category : `${category} at line ${line}`);
}

async function* iterateClaudeRows(
    source: NativeSessionSource<"claude">,
    options: HistoryReadOptions = {}
): AsyncGenerator<ParsedClaudeRow> {
    for await (const record of scanJsonlRecords({
        path: source.filePath,
        signal: options.signal,
        onIssue: options.onIssue,
    })) {
        yield {
            position: record.position,
            line: record.line,
            locator: `jsonl:${record.line}`,
            original: record.original,
            row: asRecord(record.value),
        };
    }
}

export async function* scanClaudeRecords(
    source: NativeSessionSource<"claude">,
    options: HistoryReadOptions = {}
): AsyncGenerator<HistorySourceRecord> {
    const tools: ToolContext = { names: new Map(), paths: new Map() };
    for await (const parsed of iterateClaudeRows(source, options)) {
        yield {
            position: parsed.position,
            locator: parsed.locator,
            ...claudeRecordContext(parsed.row),
            entries: recordEntries(parsed.row, parsed.line, tools),
            original: parsed.original,
        };
    }
}

export async function readClaudeRecords(
    source: NativeSessionSource<"claude">,
    options: HistoryReadOptions & { locators: string[] }
): Promise<HistoryRecordRead> {
    const requested = new Set(options.locators);
    const found = new Set<string>();
    const records: HistorySourceRecord[] = [];
    const issues: NativeSourceIssue[] = [];
    for await (const record of scanClaudeRecords(source, {
        ...options,
        onIssue: (issue) => {
            issues.push(issue);
            options.onIssue?.(issue);
        },
    })) {
        if (requested.has(record.locator)) {
            records.push(record);
            found.add(record.locator);
        }
    }

    for (const locator of requested) {
        if (!found.has(locator)) {
            const issue = boundedIssue(source, "Record locator not found");
            issues.push(issue);
            options.onIssue?.(issue);
        }
    }

    return { records, issues, complete: issues.length === 0 };
}

async function scanMetadataSegment(options: {
    source: NativeSessionSource<"claude">;
    start?: number;
    skipFirst?: boolean;
    maxRecords?: number;
    signal?: AbortSignal;
    onRow: (row: JsonRecord) => void;
    onIssue: (issue: NativeSourceIssue) => void;
}): Promise<void> {
    const stream = createReadStream(options.source.filePath, {
        ...(options.start === undefined ? {} : { start: options.start }),
        signal: options.signal,
    });
    let physicalLine = 0;
    let records = 0;
    let first = true;

    try {
        // Cut at "\n" only: readline also ends a line at U+2028 and U+2029, which JSON strings carry raw.
        for await (const original of splitLines(stream)) {
            options.signal?.throwIfAborted();
            physicalLine++;
            if (first && options.skipFirst) {
                first = false;
                continue;
            }
            first = false;
            if (!original.trim()) {
                continue;
            }
            if (options.maxRecords !== undefined && records >= options.maxRecords) {
                break;
            }
            records++;
            try {
                options.onRow(asRecord(SafeJSON.parse(original, { strict: true }) as JsonValue));
            } catch {
                options.onIssue(
                    boundedIssue(
                        options.source,
                        options.start === undefined ? "Malformed metadata record" : "Malformed metadata tail record",
                        physicalLine
                    )
                );
            }
        }
    } finally {
        stream.destroy();
    }
}

function isSubagent(source: NativeSessionSource<"claude">): boolean {
    return isClaudeSubagentPath(source.filePath);
}

/**
 * What a metadata read keeps of the rows it has read: plain JSON, because a resumable fold of a large transcript is
 * stored between processes (`jsonl-fold.ts`). The sessions index values (`source.metadata`) are applied after the
 * fold, so a kept fold stays right when the index changes.
 */
interface ClaudeMetadataFold {
    validRecords: number;
    sessionId: string | null;
    customTitle: string | null;
    summary: string | null;
    firstPrompt: string | null;
    gitBranch: string | null;
    cwd: string | null;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    userTexts: string[];
    userTextLength: number;
    allUserTextBounded: boolean;
}

function initialMetadataFold(): ClaudeMetadataFold {
    return {
        validRecords: 0,
        sessionId: null,
        customTitle: null,
        summary: null,
        firstPrompt: null,
        gitBranch: null,
        cwd: null,
        firstTimestamp: null,
        lastTimestamp: null,
        userTexts: [],
        userTextLength: 0,
        allUserTextBounded: false,
    };
}

function copyMetadataFold(fold: ClaudeMetadataFold): ClaudeMetadataFold {
    return { ...fold, userTexts: [...fold.userTexts] };
}

function nullableText(value: unknown): boolean {
    return value === null || typeof value === "string";
}

function validClaudeMetadataFold(value: unknown): value is ClaudeMetadataFold {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const fold: Record<string, unknown> = { ...value };
    return (
        typeof fold.validRecords === "number" &&
        typeof fold.userTextLength === "number" &&
        typeof fold.allUserTextBounded === "boolean" &&
        Array.isArray(fold.userTexts) &&
        fold.userTexts.every((text) => typeof text === "string") &&
        [
            "sessionId",
            "customTitle",
            "summary",
            "firstPrompt",
            "gitBranch",
            "cwd",
            "firstTimestamp",
            "lastTimestamp",
        ].every((key) => nullableText(fold[key]))
    );
}

/** One row, in file order. */
function foldClaudeMetadataRow(fold: ClaudeMetadataFold, row: JsonRecord): void {
    fold.validRecords++;
    if (autoTitleOf(row)) {
        fold.summary = autoTitleOf(row);
    }
    if (claudeCustomTitleOfRow(row)) {
        fold.customTitle = claudeCustomTitleOfRow(row);
    }
    if (!fold.sessionId && asText(row.sessionId)) {
        fold.sessionId = asText(row.sessionId);
    }
    // The newest branch wins, as in the search path: a session that moved from one branch to another
    // listed the branch it started on for days (the hub's Inbox showed a week-old branch).
    if (asText(row.gitBranch)) {
        fold.gitBranch = asText(row.gitBranch);
    }
    if (!fold.cwd && asText(row.cwd)) {
        fold.cwd = asText(row.cwd);
    }
    // An unparsable string stored here becomes `new Date(...)` = Invalid Date downstream, and
    // every NaN comparison is false, so the session would slip past every --since and --until.
    // The grok reader already refuses one; this reader storing it raw is what let a bad
    // timestamp reach `toISOString()` and abort a whole statistics read.
    const stamp = parsableTimestamp(asText(row.timestamp));

    if (stamp) {
        fold.firstTimestamp ??= stamp;
        fold.lastTimestamp = stamp;
    }

    const text = userText(row);

    if (!text || isWrapperUserText(text)) {
        return;
    }
    fold.firstPrompt ??= text;
    if (fold.userTextLength >= HISTORY_METADATA_LIMITS.allUserTextCollectedChars) {
        fold.allUserTextBounded = true;
        return;
    }

    const remaining = HISTORY_METADATA_LIMITS.allUserTextCollectedChars - fold.userTextLength;
    fold.userTexts.push(text.slice(0, remaining));
    fold.userTextLength += text.length;
    fold.allUserTextBounded ||= text.length > remaining;
}

/** One Claude transcript's metadata, timed as `metadata.claude` (the hub's listings read it for every changed file). */
export async function readClaudeMetadata(
    source: NativeSessionSource<"claude">,
    options: HistoryReadOptions = {}
): Promise<HistoryMetadataRead> {
    const parsed = { bytes: 0 };
    return profiler.scope("agent-sessions").measureAsync(
        "metadata.claude",
        () => readClaudeMetadataUncounted(source, options, parsed),
        () => ({
            file: basename(source.filePath),
            parsed: parsed.bytes,
        })
    );
}

async function readClaudeMetadataUncounted(
    source: NativeSessionSource<"claude">,
    options: HistoryReadOptions,
    parsed: { bytes: number }
): Promise<HistoryMetadataRead> {
    const issues: NativeSourceIssue[] = [];

    function issue(value: NativeSourceIssue): void {
        issues.push(value);
        options.onIssue?.(value);
    }

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
        fileStat = await stat(source.filePath);
    } catch (error) {
        const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
        const value = boundedIssue(source, missing ? "Source missing" : "Source read failed");
        issue(value);
        return { metadata: null, issues, complete: false };
    }
    const completeCoverage = fileStat.size <= LARGE_METADATA_FILE_BYTES;
    const resumable = {
        path: source.filePath,
        initial: initialMetadataFold,
        validState: validClaudeMetadataFold,
        copy: copyMetadataFold,
        apply: foldClaudeMetadataRow,
        onIssue: (message: string) => issue(sourceIssue(source.filePath, message)),
        onFolded: ({ from, to }: { from: number; to: number }) => {
            parsed.bytes += to - from;
        },
        signal: options.signal,
    };
    let fold: ClaudeMetadataFold | null;

    if (completeCoverage) {
        // Resumable (jsonl-fold.ts): a transcript that only grew is parsed from its last complete line.
        fold = foldJsonlResumable({
            ...resumable,
            storePath: genesisToolsDir("claude-history", "claude-metadata-fold.json"),
        });
    } else {
        // The head is the first records, which a growing transcript never changes: kept like a whole fold, so a live
        // 130 MB transcript stops parsing its first 1.6 MB again on every append. The tail is read as before.
        fold = foldJsonlResumable({
            ...resumable,
            storePath: genesisToolsDir("claude-history", "claude-metadata-head-fold.json"),
            maxRecords: METADATA_HEAD_RECORDS,
        });
        const head = fold;

        if (head) {
            parsed.bytes += Math.min(fileStat.size, METADATA_TAIL_BYTES);
            await scanMetadataSegment({
                source,
                start: Math.max(0, fileStat.size - METADATA_TAIL_BYTES),
                skipFirst: fileStat.size > METADATA_TAIL_BYTES,
                signal: options.signal,
                onRow: (row) => foldClaudeMetadataRow(head, row),
                onIssue: issue,
            });
        }
    }

    if (!fold || (fold.validRecords === 0 && issues.length > 0)) {
        return { metadata: null, issues, complete: false };
    }

    const { sessionId, firstPrompt, gitBranch, firstTimestamp, lastTimestamp, userTexts } = fold;
    // The sessions index names a title, a summary and a folder before any row does; a row's own title still wins.
    const customTitle = fold.customTitle ?? source.metadata?.title ?? null;
    const summary = fold.summary ?? source.metadata?.summary ?? null;
    const cwd = source.metadata?.cwd ?? fold.cwd;
    const allUserTextBounded = fold.allUserTextBounded || !completeCoverage;

    const subagent = isSubagent(source);
    const publicSessionId = sessionId ?? basename(source.filePath, ".jsonl");
    const nativeId = subagent ? claudeNativeId(source) : publicSessionId;
    const boundedFields: BoundedMetadataField[] = completeCoverage
        ? []
        : ["customTitle", "summary", "firstPrompt", "allUserText", "firstTimestamp", "lastTimestamp"];
    const boundedCustomTitle = boundHistoryText({
        value: customTitle,
        limitBytes: options.fullSummaryFields ? Infinity : HISTORY_METADATA_LIMITS.customTitleBytes,
    });
    const boundedSummary = boundHistoryText({
        value: summary,
        limitBytes: options.fullSummaryFields ? Infinity : HISTORY_METADATA_LIMITS.summaryBytes,
    });
    const boundedFirstPrompt = boundHistoryText({
        value: firstPrompt,
        limitBytes: options.fullSummaryFields ? Infinity : HISTORY_METADATA_LIMITS.firstPromptBytes,
    });
    const storageTruncatedFields: BoundedMetadataField[] = [];
    if (boundedCustomTitle.bounded) {
        storageTruncatedFields.push("customTitle");
    }
    if (boundedSummary.bounded) {
        storageTruncatedFields.push("summary");
    }
    if (boundedFirstPrompt.bounded) {
        storageTruncatedFields.push("firstPrompt");
    }

    if (boundedCustomTitle.bounded && !boundedFields.includes("customTitle")) {
        boundedFields.push("customTitle");
    }
    if (boundedSummary.bounded && !boundedFields.includes("summary")) {
        boundedFields.push("summary");
    }
    if (boundedFirstPrompt.bounded && !boundedFields.includes("firstPrompt")) {
        boundedFields.push("firstPrompt");
    }
    if (allUserTextBounded && !boundedFields.includes("allUserText")) {
        boundedFields.push("allUserText");
    }

    return {
        metadata: {
            filePath: source.filePath,
            sessionId: publicSessionId,
            customTitle: boundedCustomTitle.value,
            summary: boundedSummary.value,
            firstPrompt: boundedFirstPrompt.value,
            gitBranch,
            project: claudeProjectName({ source, cwd }),
            cwd,
            mtime: fileStat.mtimeMs,
            firstTimestamp,
            isSubagent: subagent,
            allUserText: userTexts.length > 0 ? userTexts.join(" ") : null,
            sourceHome: source.sourceHome,
            nativeId,
            ...(subagent && sessionId && sessionId !== nativeId ? { parentNativeId: sessionId } : {}),
            root: source.root,
            projectDirectory: claudeProjectDirectory(source),
            ...(lastTimestamp ? { lastTimestamp } : {}),
            archived: source.filePath.includes(`${sep}archived_sessions${sep}`),
            resumeMode: subagent ? "unsupported" : "native",
            boundedFields,
            storageTruncatedFields,
        },
        issues,
        complete: !issues.some(blocksMetadata),
    };
}

export type ClaudeHistoryOperations = HistoryOperations<"claude">;

/** The session JSONL from an offset to its end; a row's key is its `uuid`, the id a transcript scroll targets. */
async function readClaudeForward(
    source: NativeSessionSource<"claude">,
    options: ReadForwardOptions
): Promise<ForwardRead> {
    const tools: ToolContext = { names: new Map(), paths: new Map() };

    return readJsonlForward({
        ...options,
        path: source.filePath,
        rowKey: (value, position) => asText(asRecord(value).uuid) || `@${position}`,
        rowEntries: (value, line) => {
            const row = asRecord(value);

            if (row.type === "user" && (row.isMeta === true || row.isSidechain === true)) {
                return [];
            }

            return recordEntries(row, line, tools);
        },
    });
}

/**
 * The session JSONL from its end. A tool result's name comes from its call, an earlier row, so walking back from a
 * result leaves the name out until the call is reached; message text is whole.
 */
async function readClaudeBackward(
    source: NativeSessionSource<"claude">,
    options: ReadBackwardOptions
): Promise<BackwardRead> {
    const tools: ToolContext = { names: new Map(), paths: new Map() };

    return readJsonlBackward({
        ...options,
        path: source.filePath,
        rowEntries: (value, line) => {
            const row = asRecord(value);

            // Meta and sidechain user rows are harness text, never an answer from this session's user.
            if (row.type === "user" && (row.isMeta === true || row.isSidechain === true)) {
                return [];
            }

            return recordEntries(row, line, tools);
        },
    });
}

async function readClaudeTurnBoundary(
    source: NativeSessionSource<"claude">,
    options: Omit<ReadBackwardOptions, "until">
): Promise<TurnBoundary | null> {
    const tools: ToolContext = { names: new Map(), paths: new Map() };
    return readJsonlTurnBoundary({
        ...options,
        path: source.filePath,
        rowEntries: (value, line) => {
            const row = asRecord(value);
            return row.type === "user" && row.isMeta !== true && row.isSidechain !== true
                ? recordEntries(row, line, tools)
                : [];
        },
    });
}

/**
 * Claude Code (2.1.296 and later) ends a session that the ← key or `/background` moved to a new id with one trailing
 * row, `{"type":"continued-in","continuedInSessionId":"…"}`. It is the last row, so the tail is enough; a session
 * still being written ends on another row and answers undefined, as a session that was never continued does.
 */
async function readClaudeContinuedIn(
    source: NativeSessionSource<"claude">,
    options: ContinuedInOptions = {}
): Promise<string | undefined> {
    const { lines } = readLastLines(source.filePath, { maxBytes: options.maxBytes ?? CONTINUED_IN_TAIL_BYTES });

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        let row: JsonRecord;

        try {
            row = asRecord(SafeJSON.parse(lines[index], { strict: true }) as JsonValue);
        } catch {
            // A row cut by the write in progress; the pointer, when there is one, is a whole row before it.
            continue;
        }

        return row.type === "continued-in" && typeof row.continuedInSessionId === "string"
            ? row.continuedInSessionId
            : undefined;
    }

    return undefined;
}

const CONTINUED_IN_TAIL_BYTES = 64 * 1024;

/** A user or assistant row names its `uuid` and its message id, and an assistant row the ids of its tool calls. */
function claudeRowAnchors(): RowAnchorWalk {
    return (row) => {
        if (row.type !== "user" && row.type !== "assistant") {
            return { messageIds: [], toolCallIds: [], turnIds: [] };
        }

        const message = anchorRecord(row.message);
        const content = Array.isArray(message.content) ? message.content.map(anchorRecord) : [];
        return {
            messageIds: anchorStrings([row.uuid, message.id]),
            toolCallIds: anchorStrings(content.filter((part) => part.type === "tool_use").map((part) => part.id)),
            turnIds: [],
        };
    };
}

export function createClaudeHistoryOperations(): ClaudeHistoryOperations {
    return {
        parserVersion: "7",
        readMetadata: readClaudeMetadata,
        scan: scanClaudeRecords,
        readRecords: readClaudeRecords,
        readBackward: readClaudeBackward,
        readTurnBoundary: readClaudeTurnBoundary,
        readForward: readClaudeForward,
        continuedIn: readClaudeContinuedIn,
        currentModel: claudeCurrentModel,
        scanInsights: (text) => ({ native: scanClaudeNative(text), defaultModel: null }),
        rowAnchors: claudeRowAnchors,
    };
}
