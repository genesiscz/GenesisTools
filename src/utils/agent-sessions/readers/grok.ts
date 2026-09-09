import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { boundHistoryText, HISTORY_METADATA_LIMITS } from "@genesiscz/utils/agent-sessions/metadata";
import { flattenToolInput } from "@genesiscz/utils/agent-sessions/native-content";
import type { JsonRecord, JsonValue } from "@genesiscz/utils/agent-sessions/source-scan";
import { asRecord, scanJsonlRecords } from "@genesiscz/utils/agent-sessions/source-scan";
import { isWrapperUserText } from "@genesiscz/utils/agent-sessions/user-text";
import { SafeJSON } from "@genesiscz/utils/json";
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

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

interface ParsedGrokRow {
    physicalLine: number;
    position: number;
    original: string;
    row: JsonRecord;
}

interface GrokSummary {
    nativeId: string | null;
    cwd: string | null;
    title: string | null;
    summary: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

function asText(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : "";
}
function validTimestamp(value: string): string | null {
    return value && !Number.isNaN(Date.parse(value)) ? value : null;
}
function earlierTimestamp(current: string | null, candidate: string): string {
    return current === null || Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function laterTimestamp(current: string | null, candidate: string): string {
    return current === null || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function issue(path: string, message: string, options: HistoryReadOptions, issues?: NativeSourceIssue[]): void {
    const value = { path, message };
    issues?.push(value);
    options.onIssue?.(value);
}

function preferredChatPath(source: NativeSessionSource<"grok">): string | undefined {
    const candidates = [...new Set([...source.dataPaths, source.filePath])];
    return (
        candidates.find((path) => basename(path) === "chat_history.jsonl") ??
        candidates.find((path) => basename(path) === "chatHistory.jsonl")
    );
}

function summaryPath(source: NativeSessionSource<"grok">): string | undefined {
    return [...new Set([...source.metadataPaths, source.filePath])].find((path) => basename(path) === "summary.json");
}

function decodeLayoutCwd(path: string): string | null {
    const encoded = basename(dirname(dirname(path)));
    if (!encoded) {
        return null;
    }
    try {
        return decodeURIComponent(encoded);
    } catch {
        return encoded;
    }
}

function layoutNativeId(path: string): string {
    return basename(dirname(path));
}

function textBlocks(content: JsonValue | undefined): string[] {
    if (typeof content === "string") {
        return [content];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const texts: string[] = [];
    for (const value of content) {
        if (typeof value === "string") {
            texts.push(value);
            continue;
        }
        const block = asRecord(value);
        const text = asText(block.text);
        if (text) {
            texts.push(text);
        }
    }
    return texts;
}

export function extractGrokUserQueriesFromRecord(row: JsonRecord): string[] {
    if (row.type !== "user") {
        return [];
    }
    const values: string[] = [];
    for (const blob of textBlocks(row.content)) {
        const wrapped = blob.match(USER_QUERY_RE)?.[1]?.trim();
        if (wrapped) {
            values.push(wrapped);
            continue;
        }
        const text = blob.trim();

        if (!text || isWrapperUserText(text)) {
            continue;
        }
        values.push(text);
    }
    return values;
}

interface ToolContext {
    names: Map<string, string>;
    paths: Map<string, string[]>;
}

function stringifyValue(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : value === undefined ? "" : SafeJSON.stringify(value, { strict: true });
}

function inputPaths(value: JsonValue | undefined): string[] {
    const paths: string[] = [];
    function visit(candidate: JsonValue | undefined): void {
        if (Array.isArray(candidate)) {
            for (const child of candidate) {
                visit(child);
            }
            return;
        }
        if (!candidate || typeof candidate !== "object") {
            return;
        }
        for (const [name, child] of Object.entries(candidate)) {
            if (["file_path", "path", "filePath", "notebook_path"].includes(name) && typeof child === "string") {
                paths.push(child);
            } else {
                visit(child);
            }
        }
    }
    visit(value);
    return [...new Set(paths)];
}

function commitHashes(text: string): string[] {
    if (!/git (?:show|commit)|committed|Commit:/i.test(text)) {
        return [];
    }
    return [...new Set((text.match(/\b[a-f0-9]{7,40}\b/gi) ?? []).filter((value) => !/^(.)\1+$/.test(value)))];
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

function grokRecordContext(row: JsonRecord): Pick<HistorySourceRecord, "timestamp" | "role" | "metadataChanges"> {
    const timestamp = asText(row.timestamp) || undefined;
    const role = row.type === "user" || row.type === "assistant" ? row.type : undefined;
    const sessionId = asText(row.sessionId ?? row.session_id);
    const gitBranch = asText(row.gitBranch ?? row.git_branch);
    const cwd = asText(row.cwd);
    const metadataChanges = {
        ...(sessionId ? { sessionId } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(cwd ? { cwd } : {}),
    };
    return {
        ...(timestamp ? { timestamp } : {}),
        ...(role ? { role } : {}),
        ...(Object.keys(metadataChanges).length > 0 ? { metadataChanges } : {}),
    };
}

/**
 * Real Grok never emits Anthropic-shaped `tool_use` blocks. An assistant record carries a
 * top-level `tool_calls` array whose `arguments` is a JSON STRING, a tool result is its own
 * `{type:"tool_result", tool_call_id, content}` record, and reasoning arrives as
 * `{type:"reasoning", summary:[{type:"summary_text", text}]}`. Reading only the block shapes left
 * every tool call, tool result and reasoning trace out of the index, so `--tool`, `--file`,
 * `--commit` and `--commit-msg` shipped on the grok door unable to match anything.
 */
function grokToolCallEntries(row: JsonRecord, line: number, tools: ToolContext): NativeHistoryEntry[] {
    const calls = row.tool_calls;

    if (!Array.isArray(calls)) {
        return [];
    }

    const timestamp = asText(row.timestamp) || undefined;
    const entries: NativeHistoryEntry[] = [];

    for (const value of calls) {
        const call = asRecord(value);
        const name = asText(call.name);
        const id = asText(call.id);
        // `arguments` is a JSON string on the wire; parse it so paths and inputs are reachable.
        let input: JsonValue = asText(call.arguments);

        try {
            input = SafeJSON.parse(asText(call.arguments), { strict: true }) as JsonValue;
        } catch {
            // A non-JSON argument string stays searchable as text.
        }

        const inputText = flattenToolInput({ input, fieldLimit: 2_000, totalLimit: 8_000 }) || undefined;
        const paths = inputPaths(input);
        tools.names.set(id, name);
        tools.paths.set(id, paths);
        const entry = historyEntry({
            role: "tool",
            text: stringifyValue(input),
            searchText: inputText,
            inputText,
            line,
            timestamp,
            tool: name,
            toolEvent: "call",
            paths,
        });

        if (entry) {
            entries.push(entry);
        }
    }

    return entries;
}

function recordEntries(row: JsonRecord, line: number, tools: ToolContext): NativeHistoryEntry[] {
    if (row.type === "tool_result") {
        const id = asText(row.tool_call_id);
        const entry = historyEntry({
            role: "tool",
            text: stringifyValue(row.content),
            line,
            timestamp: asText(row.timestamp) || undefined,
            tool: tools.names.get(id),
            toolEvent: "result",
            paths: tools.paths.get(id),
        });

        return entry ? [entry] : [];
    }

    if (row.type === "reasoning") {
        const timestamp = asText(row.timestamp) || undefined;

        return textBlocks(row.summary)
            .map((text) => historyEntry({ role: "thinking", text, line, timestamp }))
            .filter((entry): entry is NativeHistoryEntry => entry !== undefined);
    }

    if (row.type !== "user" && row.type !== "assistant") {
        return [];
    }
    const role = row.type;
    const timestamp = asText(row.timestamp) || undefined;
    const content = row.content;
    const toolCalls = grokToolCallEntries(row, line, tools);

    if (typeof content === "string") {
        const texts = role === "user" ? extractGrokUserQueriesFromRecord(row) : [content];

        return [
            ...texts
                .map((text) => historyEntry({ role, text, line, timestamp }))
                .filter((entry): entry is NativeHistoryEntry => entry !== undefined),
            ...toolCalls,
        ];
    }
    if (!Array.isArray(content)) {
        return toolCalls;
    }

    const entries: NativeHistoryEntry[] = [...toolCalls];
    for (const value of content) {
        const block = asRecord(value);
        const type = asText(block.type);
        if (type === "tool_use") {
            const id = asText(block.id);
            const name = asText(block.name);
            const inputText =
                flattenToolInput({ input: block.input, fieldLimit: 2_000, totalLimit: 8_000 }) || undefined;
            const paths = inputPaths(block.input);
            tools.names.set(id, name);
            tools.paths.set(id, paths);
            const entry = historyEntry({
                role: "tool",
                text: stringifyValue(block.input),
                searchText: inputText,
                inputText,
                line,
                timestamp,
                tool: name,
                toolEvent: "call",
                paths,
            });
            if (entry) {
                entries.push(entry);
            }
            continue;
        }
        if (type === "tool_result") {
            const id = asText(block.tool_use_id);
            const entry = historyEntry({
                role: "tool",
                text: stringifyValue(block.content),
                line,
                timestamp,
                tool: tools.names.get(id),
                toolEvent: "result",
                paths: tools.paths.get(id),
            });
            if (entry) {
                entries.push(entry);
            }
            continue;
        }
        if (type === "thinking" || type === "reasoning_text" || type === "summary_text") {
            const entry = historyEntry({
                role: "thinking",
                text: asText(block.thinking ?? block.text),
                line,
                timestamp,
            });
            if (entry) {
                entries.push(entry);
            }
            continue;
        }
        const texts =
            role === "user"
                ? extractGrokUserQueriesFromRecord({ type: "user", content: [value] })
                : textBlocks([value])
                      .map((text) => text.trim())
                      .filter(Boolean);
        for (const text of texts) {
            const entry = historyEntry({ role, text, line, timestamp });
            if (entry) {
                entries.push(entry);
            }
        }
    }
    return entries;
}

export async function* scanGrokRecords(
    source: NativeSessionSource<"grok">,
    options: HistoryReadOptions = {}
): AsyncGenerator<HistorySourceRecord> {
    const path = preferredChatPath(source);
    if (!path) {
        issue(source.filePath, "Chat source unavailable", options);
        return;
    }
    const tools: ToolContext = { names: new Map(), paths: new Map() };
    for await (const parsed of iterateChatRows(path, options)) {
        yield {
            position: parsed.position,
            locator: `jsonl:${parsed.physicalLine}`,
            ...grokRecordContext(parsed.row),
            entries: recordEntries(parsed.row, parsed.physicalLine, tools),
            original: parsed.original,
        };
    }
}
export async function readGrokRecords(
    source: NativeSessionSource<"grok">,
    options: HistoryReadOptions & { locators: string[] }
): Promise<HistoryRecordRead> {
    const requested = new Set(options.locators);
    const found = new Set<string>();
    const records: HistorySourceRecord[] = [];
    const issues: NativeSourceIssue[] = [];
    for await (const record of scanGrokRecords(source, {
        ...options,
        onIssue: (value) => {
            issues.push(value);
            options.onIssue?.(value);
        },
    })) {
        if (requested.has(record.locator)) {
            found.add(record.locator);
            records.push(record);
        }
    }
    for (const locator of requested) {
        if (found.has(locator)) {
            continue;
        }
        issue(source.filePath, `Record locator not found: ${locator.split(":", 1)[0] || "unknown"}`, options, issues);
    }
    return { records, issues, complete: issues.length === 0 };
}

async function* iterateChatRows(
    path: string,
    options: HistoryReadOptions = {},
    issues?: NativeSourceIssue[]
): AsyncGenerator<ParsedGrokRow> {
    for await (const record of scanJsonlRecords({
        path,
        signal: options.signal,
        onIssue: (value) => {
            const message =
                value.message === "Source missing"
                    ? "Chat source missing"
                    : value.message === "Source read failed"
                      ? "Chat source read failed"
                      : value.message;
            issue(path, message, options, issues);
        },
    })) {
        yield {
            physicalLine: record.line,
            position: record.position,
            original: record.original,
            row: asRecord(record.value),
        };
    }
}

async function readSummary(
    source: NativeSessionSource<"grok">,
    options: HistoryReadOptions,
    issues: NativeSourceIssue[]
): Promise<GrokSummary> {
    const path = summaryPath(source);
    if (!path) {
        return {
            nativeId: null,
            cwd: null,
            title: null,
            summary: null,
            createdAt: null,
            updatedAt: null,
        };
    }
    let row: JsonRecord;
    try {
        row = asRecord(SafeJSON.parse(await Bun.file(path).text(), { strict: true }) as JsonValue);
    } catch {
        issue(path, "Summary metadata read failed", options, issues);
        return {
            nativeId: null,
            cwd: null,
            title: null,
            summary: null,
            createdAt: null,
            updatedAt: null,
        };
    }
    const info = asRecord(row.info);
    return {
        nativeId: asText(info.id) || null,
        cwd: asText(info.cwd) || null,
        title: asText(row.generated_title) || null,
        summary: asText(row.session_summary) || null,
        createdAt: validTimestamp(asText(row.created_at)),
        updatedAt: validTimestamp(asText(row.updated_at)),
    };
}

function pushBounded(fields: BoundedMetadataField[], field: BoundedMetadataField, condition: boolean): void {
    if (condition && !fields.includes(field)) {
        fields.push(field);
    }
}

export async function readGrokMetadata(
    source: NativeSessionSource<"grok">,
    options: HistoryReadOptions = {}
): Promise<HistoryMetadataRead> {
    const issues: NativeSourceIssue[] = [];
    const chatPath = preferredChatPath(source);
    if (!chatPath) {
        issue(source.filePath, "Chat source unavailable", options, issues);
        return { metadata: null, issues, complete: false };
    }

    let chatStat: Awaited<ReturnType<typeof stat>>;
    try {
        chatStat = await stat(chatPath);
    } catch (error) {
        const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
        issue(chatPath, missing ? "Chat source missing" : "Chat source read failed", options, issues);
        return { metadata: null, issues, complete: false };
    }

    const summary = await readSummary(source, options, issues);
    let validRecords = 0;
    let firstPrompt: string | null = null;
    let firstTimestamp = summary.createdAt;
    let lastTimestamp = summary.updatedAt ?? summary.createdAt;
    const userParts: string[] = [];
    let userCharacters = 0;
    let userBounded = false;

    for await (const parsed of iterateChatRows(chatPath, options, issues)) {
        validRecords++;
        const timestamp = validTimestamp(asText(parsed.row.timestamp));
        if (timestamp) {
            firstTimestamp = earlierTimestamp(firstTimestamp, timestamp);
            lastTimestamp = laterTimestamp(lastTimestamp, timestamp);
        }
        for (const text of extractGrokUserQueriesFromRecord(parsed.row)) {
            firstPrompt ??= text;
            if (userCharacters >= HISTORY_METADATA_LIMITS.allUserTextCollectedChars) {
                userBounded = true;
                continue;
            }
            const remaining = HISTORY_METADATA_LIMITS.allUserTextCollectedChars - userCharacters;
            userParts.push(text.slice(0, remaining));
            userCharacters += text.length;
            userBounded ||= text.length > remaining;
        }
    }

    if (validRecords === 0 && issues.length > 0) {
        return { metadata: null, issues, complete: false };
    }

    const nativeId = summary.nativeId ?? layoutNativeId(chatPath);
    const cwd = summary.cwd ?? decodeLayoutCwd(chatPath);
    const rawTitle = summary.title ?? firstPrompt?.split("\n")[0] ?? null;
    const title = boundHistoryText({
        value: rawTitle,
        limitBytes: options.fullSummaryFields ? Infinity : HISTORY_METADATA_LIMITS.customTitleBytes,
    });
    const summaryText = boundHistoryText({
        value: summary.summary,
        limitBytes: options.fullSummaryFields ? Infinity : HISTORY_METADATA_LIMITS.summaryBytes,
    });
    const prompt = boundHistoryText({
        value: firstPrompt,
        limitBytes: options.fullSummaryFields ? Infinity : HISTORY_METADATA_LIMITS.firstPromptBytes,
    });
    const boundedFields: BoundedMetadataField[] =
        issues.length > 0
            ? ["customTitle", "summary", "firstPrompt", "allUserText", "firstTimestamp", "lastTimestamp"]
            : [];
    pushBounded(boundedFields, "customTitle", title.bounded);
    pushBounded(boundedFields, "summary", summaryText.bounded);
    pushBounded(boundedFields, "firstPrompt", prompt.bounded);
    pushBounded(boundedFields, "allUserText", userBounded);
    pushBounded(boundedFields, "firstTimestamp", firstTimestamp === null);
    pushBounded(boundedFields, "lastTimestamp", lastTimestamp === null);
    const storageTruncatedFields: BoundedMetadataField[] = [];
    pushBounded(storageTruncatedFields, "customTitle", title.bounded);
    pushBounded(storageTruncatedFields, "summary", summaryText.bounded);
    pushBounded(storageTruncatedFields, "firstPrompt", prompt.bounded);

    return {
        metadata: {
            filePath: source.filePath,
            sessionId: nativeId,
            customTitle: title.value,
            summary: summaryText.value,
            firstPrompt: prompt.value,
            gitBranch: null,
            project: cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null,
            cwd,
            mtime: chatStat.mtimeMs,
            firstTimestamp,
            isSubagent: source.root.includes("worker"),
            allUserText: userParts.length > 0 ? userParts.join(" ") : null,
            sourceHome: source.sourceHome,
            nativeId,
            root: source.root,
            lastTimestamp: lastTimestamp ?? undefined,
            archived: false,
            resumeMode: "native",
            boundedFields,
            storageTruncatedFields,
        },
        issues,
        complete: issues.length === 0,
    };
}

export type GrokHistoryOperations = Pick<NativeSessionReader<"grok">, "parserVersion"> &
    Required<Pick<NativeSessionReader<"grok">, "readMetadata" | "scan" | "readRecords">>;

export function createGrokHistoryOperations(): GrokHistoryOperations {
    return {
        parserVersion: "3",
        readMetadata: readGrokMetadata,
        scan: scanGrokRecords,
        readRecords: readGrokRecords,
    };
}
