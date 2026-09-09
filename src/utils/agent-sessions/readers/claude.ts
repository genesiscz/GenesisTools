import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import { createInterface } from "node:readline";
import { flattenToolInput } from "@genesiscz/utils/agent-sessions/native-content";
import type { JsonRecord, JsonValue } from "@genesiscz/utils/agent-sessions/source-scan";
import { asRecord, scanJsonlRecords } from "@genesiscz/utils/agent-sessions/source-scan";
import { isWrapperUserText } from "@genesiscz/utils/agent-sessions/user-text";
import { SafeJSON } from "@genesiscz/utils/json";
import { boundHistoryText, HISTORY_METADATA_LIMITS } from "../metadata";
import type {
    BoundedMetadataField,
    HistoryMetadataRead,
    HistoryReadOptions,
    HistoryRecordRead,
    HistorySourceRecord,
    NativeHistoryEntry,
    NativeSessionReader,
    NativeSessionSource,
    NativeSourceIssue,
} from "../types";
import { claudeNativeId, claudeProjectDirectory, claudeProjectName, isClaudeSubagentPath } from "./claude-paths";

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

interface ToolContext {
    names: Map<string, string>;
    paths: Map<string, string[]>;
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

function historyEntry(options: {
    role: NativeHistoryEntry["role"];
    text: string;
    line: number;
    timestamp?: string;
    tool?: string;
    toolEvent?: "call" | "result";
    inputText?: string;
    searchText?: string;
    paths?: string[];
}): NativeHistoryEntry | undefined {
    if (!options.text && !options.searchText) {
        return;
    }

    return {
        line: options.line,
        role: options.role,
        text: options.text,
        ...(options.searchText ? { searchText: options.searchText } : {}),
        ...(options.tool ? { tool: options.tool } : {}),
        ...(options.toolEvent ? { toolEvent: options.toolEvent } : {}),
        ...(options.inputText ? { inputText: options.inputText } : {}),
        paths: options.paths ?? [],
        commits: commitHashes(options.text),
        ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    };
}

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

function claudeRecordContext(row: JsonRecord): Pick<HistorySourceRecord, "timestamp" | "role" | "metadataChanges"> {
    const timestamp = asText(row.timestamp) || undefined;
    const role =
        row.type === "user" || row.type === "assistant"
            ? row.type
            : row.type === "queue-operation" || row.type === "summary" || row.type === "custom-title"
              ? "system"
              : undefined;
    const sessionId = asText(row.sessionId);
    const customTitle = row.type === "custom-title" ? asText(row.customTitle) : "";
    const summary = row.type === "summary" ? asText(row.summary) : "";
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
    if (row.type === "queue-operation" || row.type === "summary" || row.type === "custom-title") {
        const text =
            row.type === "summary"
                ? asText(row.summary)
                : row.type === "custom-title"
                  ? asText(row.customTitle)
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
        encoding: "utf8",
        signal: options.signal,
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let physicalLine = 0;
    let records = 0;
    let first = true;

    try {
        for await (const original of lines) {
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
        lines.close();
        stream.destroy();
    }
}

function isSubagent(source: NativeSessionSource<"claude">): boolean {
    return isClaudeSubagentPath(source.filePath);
}

export async function readClaudeMetadata(
    source: NativeSessionSource<"claude">,
    options: HistoryReadOptions = {}
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
    let validRecords = 0;
    let sessionId: string | null = null;
    let customTitle: string | null = source.metadata?.title ?? null;
    let summary: string | null = source.metadata?.summary ?? null;
    let firstPrompt: string | null = null;
    let gitBranch: string | null = null;
    let cwd: string | null = source.metadata?.cwd ?? null;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    const userTexts: string[] = [];
    let userTextLength = 0;
    let allUserTextBounded = !completeCoverage;

    function apply(row: JsonRecord): void {
        validRecords++;
        if (row.type === "summary" && asText(row.summary)) {
            summary = asText(row.summary);
        }
        if (row.type === "custom-title" && asText(row.customTitle)) {
            customTitle = asText(row.customTitle);
        }
        if (!sessionId && asText(row.sessionId)) {
            sessionId = asText(row.sessionId);
        }
        if (!gitBranch && asText(row.gitBranch)) {
            gitBranch = asText(row.gitBranch);
        }
        if (!cwd && asText(row.cwd)) {
            cwd = asText(row.cwd);
        }
        // An unparsable string stored here becomes `new Date(...)` = Invalid Date downstream, and
        // every NaN comparison is false, so the session would slip past every --since and --until.
        // The grok reader already refuses one; this reader storing it raw is what let a bad
        // timestamp reach `toISOString()` and abort a whole statistics read.
        const stamp = parsableTimestamp(asText(row.timestamp));

        if (stamp) {
            firstTimestamp ??= stamp;
            lastTimestamp = stamp;
        }

        const text = userText(row);

        if (!text || isWrapperUserText(text)) {
            return;
        }
        firstPrompt ??= text;
        if (userTextLength >= HISTORY_METADATA_LIMITS.allUserTextCollectedChars) {
            allUserTextBounded = true;
            return;
        }

        const remaining = HISTORY_METADATA_LIMITS.allUserTextCollectedChars - userTextLength;
        userTexts.push(text.slice(0, remaining));
        userTextLength += text.length;
        allUserTextBounded ||= text.length > remaining;
    }

    if (completeCoverage) {
        for await (const parsed of iterateClaudeRows(source, { ...options, onIssue: issue })) {
            apply(parsed.row);
        }
    } else {
        await scanMetadataSegment({
            source,
            maxRecords: METADATA_HEAD_RECORDS,
            signal: options.signal,
            onRow: apply,
            onIssue: issue,
        });
        await scanMetadataSegment({
            source,
            start: Math.max(0, fileStat.size - METADATA_TAIL_BYTES),
            skipFirst: fileStat.size > METADATA_TAIL_BYTES,
            signal: options.signal,
            onRow: apply,
            onIssue: issue,
        });
    }

    if (validRecords === 0 && issues.length > 0) {
        return { metadata: null, issues, complete: false };
    }

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
        complete: issues.length === 0,
    };
}

export type ClaudeHistoryOperations = Pick<NativeSessionReader<"claude">, "parserVersion"> &
    Required<Pick<NativeSessionReader<"claude">, "readMetadata" | "scan" | "readRecords">>;

export function createClaudeHistoryOperations(): ClaudeHistoryOperations {
    return {
        parserVersion: "5",
        readMetadata: readClaudeMetadata,
        scan: scanClaudeRecords,
        readRecords: readClaudeRecords,
    };
}
