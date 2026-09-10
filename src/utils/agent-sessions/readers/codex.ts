import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { sep } from "node:path";

import { flattenToolInput } from "@genesiscz/utils/agent-sessions/native-content";
import type { JsonRecord, JsonValue } from "@genesiscz/utils/agent-sessions/source-scan";
import { asRecord, blocksMetadata, scanJsonlRecords } from "@genesiscz/utils/agent-sessions/source-scan";
import { isWrapperUserText } from "@genesiscz/utils/agent-sessions/user-text";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
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

interface ParsedCodexRow {
    physicalLine: number;
    position: number;
    original: string;
    row: JsonRecord;
}

interface CodexHeader {
    nativeId: string;
    parentNativeId?: string;
    cwd: string | null;
    gitBranch: string | null;
    historyMode: string;
    isSubagent: boolean;
    timestamp: string | null;
}

interface NativeStateMetadata {
    title: string | null;
    summary: string | null;
    cwd: string | null;
    archived?: boolean;
}

function asText(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : "";
}

function sourceIssue(source: NativeSessionSource<"codex">, message: string): NativeSourceIssue {
    return { path: source.filePath, message };
}

function reportIssue(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions,
    issues: NativeSourceIssue[] | undefined,
    message: string
): void {
    const issue = sourceIssue(source, message);
    issues?.push(issue);
    options.onIssue?.(issue);
}

/**
 * Codex wrote a bare `{id, timestamp, instructions}` opening record before it introduced the
 * `session_meta` wrapper. Every row of the current format carries `type`, so requiring its
 * absence keeps this from claiming an ordinary record. Four rollouts here still use it, and
 * without this they were reported as "Native session header missing" on every codex search.
 */
function legacyFlatHeader(row: JsonRecord): CodexHeader | undefined {
    const nativeId = asText(row.id);

    if ("type" in row || !nativeId || !("timestamp" in row) || !("instructions" in row)) {
        return;
    }

    return {
        nativeId,
        cwd: null,
        gitBranch: null,
        historyMode: "legacy",
        isSubagent: false,
        timestamp: asText(row.timestamp) || null,
    };
}

export type { CodexHeader };

/**
 * The single place that decides whether a row is a Codex session header. Discovery used to carry
 * its own copy that only accepted `session_meta`, so a pre-2026 rollout was reported as
 * "Native session header missing" AND its whole root was marked incomplete, which is the same
 * shape of defect that stopped pruning and froze statistics on the Claude side.
 */
export function parseCodexHeaderRow(row: JsonRecord): CodexHeader | undefined {
    return firstHeader(row);
}

function firstHeader(row: JsonRecord): CodexHeader | undefined {
    if (row.type !== "session_meta") {
        return legacyFlatHeader(row);
    }
    const payload = asRecord(row.payload);
    // `id` before `session_id`, and the order is not cosmetic. On a forked or resumed rollout
    // `session_id` names the PARENT conversation while `id` names this file, so reading
    // `session_id` first collapses every fork of one thread onto a single native id. Real corpus:
    // 69 rollouts across two profile homes read as 18 sessions that way, one owning 27 files,
    // which looks exactly like a violation of session_metadata's UNIQUE(provider, native_id,
    // source_home). The parent is preserved below as `parentNativeId` instead.
    const nativeId = asText(payload.id ?? payload.session_id);
    if (!nativeId) {
        return;
    }
    const parent = asText(payload.session_id);
    return {
        nativeId,
        ...(parent && parent !== nativeId ? { parentNativeId: parent } : {}),
        cwd: asText(payload.cwd) || null,
        gitBranch: asText(asRecord(payload.git).branch) || null,
        historyMode: asText(payload.history_mode) || "legacy",
        isSubagent: Boolean(asRecord(payload.source).subagent),
        timestamp: asText(row.timestamp ?? payload.timestamp) || null,
    };
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
        if (typeof block.text === "string") {
            texts.push(block.text);
        }
    }
    return texts;
}

function userMessage(row: JsonRecord): string {
    if (row.type !== "response_item") {
        return "";
    }
    const payload = asRecord(row.payload);
    if (payload.type !== "message" || payload.role !== "user") {
        return "";
    }
    return textBlocks(payload.content).join("\n");
}
interface ToolContext {
    names: Map<string, string>;
    paths: Map<string, string[]>;
}

function stringifyValue(value: JsonValue | undefined): string {
    return typeof value === "string" ? value : value === undefined ? "" : SafeJSON.stringify(value, { strict: true });
}

function toolInput(value: JsonValue | undefined): JsonValue | undefined {
    if (typeof value !== "string") {
        return value;
    }
    try {
        return SafeJSON.parse(value, { strict: true }) as JsonValue;
    } catch {
        return value;
    }
}

function toolPaths(value: JsonValue | undefined): string[] {
    const input = toolInput(value);
    const paths: string[] = [];
    function collect(candidate: JsonValue | undefined): void {
        if (Array.isArray(candidate)) {
            for (const child of candidate) {
                collect(child);
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
                collect(child);
            }
        }
    }
    collect(input);
    const command = stringifyValue(input);
    paths.push(
        ...(command.match(
            /(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+|\b[\w-]+\.(?:tsx?|jsx?|json|py|php|rs|go|md|sql|ya?ml|toml)\b/g
        ) ?? [])
    );
    return [...new Set(paths)];
}

function commitHashes(text: string): string[] {
    if (!/git (?:show|commit)|committed|Commit:/i.test(text)) {
        return [];
    }
    return [...new Set((text.match(/\b[a-f0-9]{7,40}\b/gi) ?? []).filter((value) => !/^(.)\1+$/.test(value)))];
}

function entry(options: {
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
    role: "user" | "assistant";
    line: number;
    timestamp?: string;
}): NativeHistoryEntry[] {
    const results: NativeHistoryEntry[] = [];
    for (const text of textBlocks(options.content)) {
        const value = entry({ role: options.role, text, line: options.line, timestamp: options.timestamp });
        if (value) {
            results.push(value);
        }
    }
    return results;
}

function legacyRecordContext(row: JsonRecord): Pick<HistorySourceRecord, "timestamp" | "role" | "metadataChanges"> {
    const payload = asRecord(row.payload);
    const timestamp = asText(row.timestamp ?? payload.timestamp) || undefined;
    let role: NativeHistoryEntry["role"] | undefined;
    if (row.type === "response_item") {
        if (payload.type === "message") {
            role = payload.role === "user" ? "user" : "assistant";
        } else if (payload.type === "reasoning") {
            role = "thinking";
        } else if (
            payload.type === "function_call" ||
            payload.type === "custom_tool_call" ||
            payload.type === "function_call_output" ||
            payload.type === "custom_tool_call_output"
        ) {
            role = "tool";
        }
    } else if (row.type === "session_meta") {
        role = "system";
    }
    // Metadata was resolved from the first native header plus current state sidecars.
    // Replaying inherited headers here would overwrite the child's identity and cwd.
    return {
        ...(timestamp ? { timestamp } : {}),
        ...(role ? { role } : {}),
    };
}

function projectionRecordContext(item: JsonRecord, createdAt: number): Pick<HistorySourceRecord, "timestamp" | "role"> {
    const timestamp = Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : undefined;
    const type = asText(item.type);
    const role = projectionEntriesRole(type);
    return { ...(timestamp ? { timestamp } : {}), ...(role ? { role } : {}) };
}

function projectionEntriesRole(type: string): NativeHistoryEntry["role"] | undefined {
    if (type === "userMessage") {
        return "user";
    }
    if (type === "agentMessage" || type === "plan") {
        return "assistant";
    }
    if (type === "reasoning") {
        return "thinking";
    }
    if (
        [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "functionCallOutput",
            "webSearch",
            "collabAgentToolCall",
        ].includes(type)
    ) {
        return "tool";
    }
    if (
        [
            "hookPrompt",
            "subAgentActivity",
            "imageView",
            "sleep",
            "imageGeneration",
            "enteredReviewMode",
            "exitedReviewMode",
            "contextCompaction",
        ].includes(type)
    ) {
        return "system";
    }
}

function legacyEntries(row: JsonRecord, line: number, tools: ToolContext): NativeHistoryEntry[] {
    if (row.type !== "response_item") {
        return [];
    }
    const payload = asRecord(row.payload);
    const timestamp = asText(row.timestamp ?? payload.timestamp) || undefined;
    if (payload.type === "message") {
        return contentEntries({
            content: payload.content,
            role: payload.role === "user" ? "user" : "assistant",
            line,
            timestamp,
        });
    }
    if (payload.type === "reasoning") {
        const results: NativeHistoryEntry[] = [];
        for (const text of textBlocks(payload.summary ?? payload.content)) {
            const value = entry({ role: "thinking", text, line, timestamp });
            if (value) {
                results.push(value);
            }
        }
        return results;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = asText(payload.name);
        const id = asText(payload.call_id);
        const input = payload.arguments ?? payload.input;
        const paths = toolPaths(input);
        tools.names.set(id, name);
        tools.paths.set(id, paths);
        const text = stringifyValue(input);
        const inputText =
            flattenToolInput({ input: toolInput(input), fieldLimit: 2_000, totalLimit: 8_000 }) || undefined;
        const value = entry({
            role: "tool",
            text,
            searchText: inputText,
            inputText,
            line,
            timestamp,
            tool: name,
            toolEvent: "call",
            paths,
        });
        return value ? [value] : [];
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const id = asText(payload.call_id);
        const value = entry({
            role: "tool",
            text: stringifyValue(payload.output),
            line,
            timestamp,
            tool: tools.names.get(id),
            toolEvent: "result",
            paths: tools.paths.get(id),
        });
        return value ? [value] : [];
    }
    return [];
}

interface ProjectionRow {
    rollout_ordinal: number;
    created_at_ms: number;
    item_json: string;
    updated_at_ordinal?: number;
}

async function readAuthoritativeHeader(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions
): Promise<CodexHeader | undefined> {
    for await (const parsed of iterateLegacyRows(source, options)) {
        const header = firstHeader(parsed.row);
        if (header) {
            return header;
        }
    }
}

function projectionEntries(
    source: NativeSessionSource<"codex">,
    item: JsonRecord,
    ordinal: number,
    createdAt: number
): NativeHistoryEntry[] {
    const timestamp = Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : undefined;
    const type = asText(item.type);
    if (type === "userMessage") {
        return contentEntries({ content: item.content, role: "user", line: ordinal, timestamp });
    }
    if (type === "agentMessage" || type === "plan") {
        const value = entry({ role: "assistant", text: asText(item.text), line: ordinal, timestamp });
        return value ? [value] : [];
    }
    if (type === "reasoning") {
        const value = entry({
            role: "thinking",
            text: [...textBlocks(item.summary), ...textBlocks(item.content)].join("\n"),
            line: ordinal,
            timestamp,
        });
        return value ? [value] : [];
    }
    if (type === "commandExecution") {
        const text = [asText(item.command), asText(item.aggregatedOutput)].filter(Boolean).join("\n");
        const value = entry({
            role: "tool",
            text,
            line: ordinal,
            timestamp,
            tool: "exec_command",
            toolEvent: "call",
            inputText: asText(item.command) || undefined,
            paths: toolPaths(item.command),
        });
        return value ? [value] : [];
    }
    if (type === "fileChange") {
        const value = entry({
            role: "tool",
            text: stringifyValue(item.changes),
            line: ordinal,
            timestamp,
            tool: "apply_patch",
            toolEvent: "call",
            inputText: flattenToolInput({ input: item.changes }) || undefined,
            paths: toolPaths(item.changes),
        });
        return value ? [value] : [];
    }
    if (type === "mcpToolCall" || type === "dynamicToolCall") {
        const value = entry({
            role: "tool",
            text: [
                stringifyValue(item.arguments),
                stringifyValue(item.result ?? item.contentItems),
                stringifyValue(item.error),
            ]
                .filter(Boolean)
                .join("\n"),
            line: ordinal,
            timestamp,
            tool: asText(item.tool),
            toolEvent: "call",
            inputText: flattenToolInput({ input: item.arguments }) || undefined,
            paths: toolPaths(item.arguments),
        });
        return value ? [value] : [];
    }
    if (type === "functionCallOutput") {
        const value = entry({
            role: "tool",
            text: stringifyValue(item.output),
            line: ordinal,
            timestamp,
            tool: asText(item.name),
            toolEvent: "result",
        });
        return value ? [value] : [];
    }
    if (type === "webSearch") {
        const value = entry({
            role: "tool",
            text: stringifyValue(item.action),
            line: ordinal,
            timestamp,
            tool: "web_search",
            toolEvent: "call",
            inputText: flattenToolInput({ input: item.action }) || undefined,
        });
        return value ? [value] : [];
    }
    if (type === "collabAgentToolCall") {
        const value = entry({
            role: "tool",
            text: [asText(item.prompt), stringifyValue(item.agentsStates)].filter(Boolean).join("\n"),
            line: ordinal,
            timestamp,
            tool: asText(item.tool),
            toolEvent: "call",
            inputText: asText(item.prompt) || undefined,
        });
        return value ? [value] : [];
    }
    if (
        [
            "hookPrompt",
            "subAgentActivity",
            "imageView",
            "sleep",
            "imageGeneration",
            "enteredReviewMode",
            "exitedReviewMode",
            "contextCompaction",
        ].includes(type)
    ) {
        const value = entry({
            role: "system",
            text: SafeJSON.stringify(item, { strict: true }),
            line: ordinal,
            timestamp,
        });
        return value ? [value] : [];
    }
    // Not an issue: an item kind this build does not know yet is forward compatibility, not
    // corruption. Reporting it marked the read incomplete, and `complete: issues.length === 0`
    // then dropped the whole conversation from search results.
    logger.debug({ path: source.filePath, ordinal, type }, "Unsupported paginated Codex item kind");
    return [];
}

interface ProjectionFingerprintPart {
    database: number;
    count: number;
    ordinal: number;
    revision?: number;
    contentHash?: string;
}

export async function readCodexProjectionFingerprint(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions & { nativeId?: string } = {}
): Promise<string | undefined> {
    const nativeId = options.nativeId ?? (await readAuthoritativeHeader(source, options))?.nativeId;
    if (!nativeId) {
        reportIssue(source, options, undefined, "Native session header missing");
        return;
    }
    const parts: ProjectionFingerprintPart[] = [];
    const paths = source.metadataPaths.filter((path) => /thread_history(?:_\d+)?\.sqlite$/.test(path));
    for (const [databaseIndex, path] of paths.entries()) {
        let database: Database | undefined;
        try {
            options.signal?.throwIfAborted();
            database = new Database(path, { readonly: true });
            const columns = sqliteColumns(database, "thread_items");
            if (
                !columns.includes("thread_id") ||
                !columns.includes("rollout_ordinal") ||
                !columns.includes("item_json")
            ) {
                continue;
            }
            if (columns.includes("updated_at_ordinal")) {
                const row = database
                    .query(
                        "SELECT count(*) AS count, coalesce(max(rollout_ordinal), 0) AS ordinal, coalesce(max(updated_at_ordinal), 0) AS revision FROM thread_items WHERE thread_id = ?"
                    )
                    .get(nativeId) as { count: number; ordinal: number; revision: number };
                if (row.count > 0) {
                    parts.push({ database: databaseIndex, ...row });
                }
                continue;
            }
            const hash = createHash("sha256");
            let count = 0;
            let ordinal = 0;
            for (const row of database
                .query(
                    "SELECT rollout_ordinal, item_json FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal"
                )
                .iterate(nativeId) as Iterable<{ rollout_ordinal: number; item_json: string }>) {
                count++;
                ordinal = Math.max(ordinal, row.rollout_ordinal);
                hash.update(`${row.rollout_ordinal}:${row.item_json}\n`);
            }
            if (count > 0) {
                parts.push({ database: databaseIndex, count, ordinal, contentHash: hash.digest("hex") });
            }
        } catch {
            reportIssue(source, options, undefined, "Projection fingerprint read failed");
        } finally {
            database?.close();
        }
    }
    return parts.length > 0 ? SafeJSON.stringify(parts, { strict: true }) : undefined;
}

/**
 * The one ADVISORY issue this reader raises: the thread is in no `thread_history*.sqlite`, so
 * the rollout was read instead. It is still reported — `history index status` should name it, and
 * for a forked rollout the first prompt it yields may be the parent's — but it must not make the
 * READ incomplete, because `sync.ts` DISCARDS the metadata of an incomplete read (`!read.complete
 * -> return null`). On this machine that was 144 issues and 88 codex sessions indexed with no
 * first prompt at all. Same reasoning as the unsupported-item-kind note above.
 */
const PROJECTION_UNAVAILABLE = "Paginated projection unavailable for native thread";

/** Issues that fail a read. The advisory one above is reported and then forgiven. */
function fatalIssueCount(issues: readonly NativeSourceIssue[]): number {
    return issues.filter((issue) => issue.message !== PROJECTION_UNAVAILABLE).length;
}

async function* scanProjectionRecords(
    source: NativeSessionSource<"codex">,
    header: CodexHeader,
    options: HistoryReadOptions
): AsyncGenerator<HistorySourceRecord> {
    const paths = source.metadataPaths.filter((path) => /thread_history(?:_\d+)?\.sqlite$/.test(path));
    let found = false;
    let position = 0;
    for (const [databaseIndex, path] of paths.entries()) {
        let database: Database | undefined;
        try {
            options.signal?.throwIfAborted();
            database = new Database(path, { readonly: true });
            const columns = sqliteColumns(database, "thread_items");
            if (
                !columns.includes("thread_id") ||
                !columns.includes("rollout_ordinal") ||
                !columns.includes("item_json")
            ) {
                reportIssue(source, options, undefined, "Paginated projection schema unsupported");
                continue;
            }
            const hasCreatedAt = columns.includes("created_at_ms");
            const hasRevision = columns.includes("updated_at_ordinal");
            const selected = [
                "rollout_ordinal",
                hasCreatedAt ? "created_at_ms" : "0 AS created_at_ms",
                "item_json",
                hasRevision ? "updated_at_ordinal" : "NULL AS updated_at_ordinal",
            ];
            const rows = database
                .query(`SELECT ${selected.join(", ")} FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal`)
                .iterate(header.nativeId) as Iterable<ProjectionRow>;
            let foundInDatabase = false;
            for (const row of rows) {
                options.signal?.throwIfAborted();
                found = true;
                foundInDatabase = true;
                let item: JsonRecord;
                try {
                    item = asRecord(SafeJSON.parse(row.item_json, { strict: true }) as JsonValue);
                } catch {
                    reportIssue(
                        source,
                        options,
                        undefined,
                        `Malformed paginated item at ordinal ${row.rollout_ordinal}`
                    );
                    continue;
                }
                const revision = row.updated_at_ordinal ?? 0;
                yield {
                    position: position++,
                    locator: `projection:${databaseIndex}:${row.rollout_ordinal}:${revision}`,
                    ...projectionRecordContext(item, row.created_at_ms),
                    entries: projectionEntries(source, item, row.rollout_ordinal, row.created_at_ms),
                    original: row.item_json,
                };
            }
            if (foundInDatabase) {
                break;
            }
        } catch {
            reportIssue(source, options, undefined, "Paginated projection read failed");
        } finally {
            database?.close();
        }
    }
    if (!found) {
        reportIssue(source, options, undefined, PROJECTION_UNAVAILABLE);
    }
}

export async function* scanCodexRecords(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions = {}
): AsyncGenerator<HistorySourceRecord> {
    const header = await readAuthoritativeHeader(source, options);
    if (!header) {
        reportIssue(source, options, undefined, "Native session header missing");
        return;
    }
    if (header.historyMode === "paginated") {
        let projected = 0;
        for await (const record of scanProjectionRecords(source, header, options)) {
            projected++;
            yield record;
        }
        // Nothing at all came back, which `scanProjectionRecords` has already reported: the
        // per-home projection database was left behind by a `migrate-home` copy, or the home
        // was rebuilt around the rollout. The rollout still holds every response item, so
        // reading it is strictly more than the empty session this used to return.
        if (projected > 0) {
            return;
        }
    }
    const tools: ToolContext = { names: new Map(), paths: new Map() };
    for await (const parsed of iterateLegacyRows(source, options)) {
        yield {
            position: parsed.position,
            locator: `jsonl:${parsed.physicalLine}`,
            ...legacyRecordContext(parsed.row),
            entries: legacyEntries(parsed.row, parsed.physicalLine, tools),
            original: parsed.original,
        };
    }
}
export async function readCodexRecords(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions & { locators: string[] }
): Promise<HistoryRecordRead> {
    const requested = new Set(options.locators);
    const found = new Set<string>();
    const records: HistorySourceRecord[] = [];
    const issues: NativeSourceIssue[] = [];
    for await (const record of scanCodexRecords(source, {
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
        if (found.has(locator)) {
            continue;
        }
        const family = locator.split(":", 1)[0] || "unknown";
        reportIssue(source, options, issues, `Record locator not found: ${family}`);
    }
    return { records, issues, complete: fatalIssueCount(issues) === 0 };
}

async function* iterateLegacyRows(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions = {},
    issues?: NativeSourceIssue[]
): AsyncGenerator<ParsedCodexRow> {
    for await (const record of scanJsonlRecords({
        path: source.filePath,
        signal: options.signal,
        onIssue: (value) => {
            issues?.push(value);
            options.onIssue?.(value);
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

function sqliteColumns(database: Database, table: string): string[] {
    return (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name
    );
}

async function readNativeMetadata(
    source: NativeSessionSource<"codex">,
    nativeId: string,
    options: HistoryReadOptions,
    issues: NativeSourceIssue[]
): Promise<NativeStateMetadata> {
    let metadata: NativeStateMetadata =
        source.metadata?.sessionId === nativeId
            ? {
                  title: source.metadata.title ?? null,
                  summary: source.metadata.summary ?? null,
                  cwd: source.metadata.cwd ?? null,
                  ...(source.metadata.archived === undefined ? {} : { archived: source.metadata.archived }),
              }
            : { title: null, summary: null, cwd: null };
    for (const path of source.metadataPaths.filter(
        (candidate) => candidate.endsWith(".sqlite") && !/thread_history(?:_\d+)?\.sqlite$/.test(candidate)
    )) {
        let database: Database | undefined;
        try {
            database = new Database(path, { readonly: true });
            const columns = sqliteColumns(database, "threads");
            if (!columns.includes("id")) {
                continue;
            }
            const selected = ["title", "summary", "cwd", "archived"].filter((column) => columns.includes(column));
            if (selected.length === 0) {
                continue;
            }
            const row = database
                .query(`SELECT ${selected.join(", ")} FROM threads WHERE id = ? LIMIT 1`)
                .get(nativeId) as JsonRecord | null;
            if (row) {
                metadata = {
                    title: asText(row.title) || metadata.title,
                    summary: asText(row.summary) || metadata.summary,
                    cwd: asText(row.cwd) || metadata.cwd,
                    ...(row.archived === undefined
                        ? metadata.archived === undefined
                            ? {}
                            : { archived: metadata.archived }
                        : { archived: Boolean(row.archived) }),
                };
            }
        } catch {
            reportIssue(source, options, issues, "Native state metadata read failed");
        } finally {
            database?.close();
        }
    }
    for (const path of source.metadataPaths.filter((candidate) => candidate.endsWith("session_index.jsonl"))) {
        let raw: string;
        try {
            raw = await Bun.file(path).text();
        } catch {
            reportIssue(source, options, issues, "Native session index read failed");
            continue;
        }
        const rows = raw.split("\n");
        for (let index = 0; index < rows.length; index++) {
            const original = rows[index] ?? "";
            if (!original.trim()) {
                continue;
            }
            let row: JsonRecord;
            try {
                row = asRecord(SafeJSON.parse(original, { strict: true }) as JsonValue);
            } catch {
                reportIssue(source, options, issues, `Malformed native metadata record at line ${index + 1}`);
                continue;
            }
            if (asText(row.id ?? row.session_id) !== nativeId) {
                continue;
            }
            metadata = {
                title: asText(row.thread_name ?? row.title) || metadata.title,
                summary: asText(row.summary) || metadata.summary,
                cwd: metadata.cwd,
                ...(metadata.archived === undefined ? {} : { archived: metadata.archived }),
            };
        }
    }
    return metadata;
}

function projectName(cwd: string | null): string | null {
    return cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;
}

function pushBoundedField(fields: BoundedMetadataField[], field: BoundedMetadataField, bounded: boolean): void {
    if (bounded && !fields.includes(field)) {
        fields.push(field);
    }
}

export async function readCodexMetadata(
    source: NativeSessionSource<"codex">,
    options: HistoryReadOptions = {}
): Promise<HistoryMetadataRead> {
    const issues: NativeSourceIssue[] = [];
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
        fileStat = await stat(source.filePath);
    } catch (error) {
        const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
        reportIssue(source, options, issues, missing ? "Source missing" : "Source read failed");
        return { metadata: null, issues, complete: false };
    }

    let header: CodexHeader | undefined;
    let firstPrompt: string | null = null;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    const userTextParts: string[] = [];
    let userTextCharacters = 0;
    let userTextBounded = false;

    function applyUserText(text: string): void {
        if (!text || isWrapperUserText(text)) {
            return;
        }
        firstPrompt ??= text;
        if (userTextCharacters >= HISTORY_METADATA_LIMITS.allUserTextCollectedChars) {
            userTextBounded = true;
            return;
        }
        const remaining = HISTORY_METADATA_LIMITS.allUserTextCollectedChars - userTextCharacters;
        userTextParts.push(text.slice(0, remaining));
        userTextCharacters += text.length;
        userTextBounded ||= text.length > remaining;
    }

    for await (const parsed of iterateLegacyRows(source, options, issues)) {
        const candidate = firstHeader(parsed.row);
        if (!header && candidate) {
            header = candidate;
            firstTimestamp = candidate.timestamp;
        }
        const timestamp = asText(parsed.row.timestamp ?? asRecord(parsed.row.payload).timestamp);
        if (timestamp) {
            firstTimestamp ??= timestamp;
            lastTimestamp = timestamp;
        }
        applyUserText(userMessage(parsed.row));
    }

    if (!header) {
        if (issues.length === 0) {
            reportIssue(source, options, issues, "Native session header missing");
        }
        return { metadata: null, issues, complete: false };
    }

    if (header.historyMode === "paginated") {
        // Kept, not thrown away: the projection wins because a forked rollout replays its
        // parent's items, but a thread with NO projection row has only the rollout, and
        // blanking it unconditionally is what made a migrated session read as empty.
        const fromRollout = {
            firstPrompt,
            parts: [...userTextParts],
            characters: userTextCharacters,
            bounded: userTextBounded,
        };
        firstPrompt = null;
        userTextParts.length = 0;
        userTextCharacters = 0;
        userTextBounded = false;
        let projectionFound = false;
        const paths = source.metadataPaths.filter((path) => /thread_history(?:_\d+)?\.sqlite$/.test(path));
        for (const path of paths) {
            let database: Database | undefined;
            try {
                options.signal?.throwIfAborted();
                database = new Database(path, { readonly: true });
                const columns = sqliteColumns(database, "thread_items");
                if (
                    !columns.includes("thread_id") ||
                    !columns.includes("rollout_ordinal") ||
                    !columns.includes("item_json")
                ) {
                    reportIssue(source, options, issues, "Paginated projection schema unsupported");
                    continue;
                }
                const createdAt = columns.includes("created_at_ms") ? "created_at_ms" : "0 AS created_at_ms";
                const rows = database
                    .query(
                        `SELECT ${createdAt}, item_json FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal`
                    )
                    .iterate(header.nativeId) as Iterable<{ created_at_ms: number; item_json: string }>;
                let foundInDatabase = false;
                for (const row of rows) {
                    options.signal?.throwIfAborted();
                    projectionFound = true;
                    foundInDatabase = true;
                    if (Number.isFinite(row.created_at_ms) && row.created_at_ms > 0) {
                        const timestamp = new Date(row.created_at_ms).toISOString();
                        firstTimestamp ??= timestamp;
                        lastTimestamp = timestamp;
                    }
                    let item: JsonRecord;
                    try {
                        item = asRecord(SafeJSON.parse(row.item_json, { strict: true }) as JsonValue);
                    } catch {
                        reportIssue(source, options, issues, "Malformed paginated metadata item");
                        continue;
                    }
                    if (item.type === "userMessage") {
                        applyUserText(textBlocks(item.content).join("\n"));
                    }
                }
                if (foundInDatabase) {
                    break;
                }
            } catch {
                reportIssue(source, options, issues, "Paginated metadata read failed");
            } finally {
                database?.close();
            }
        }
        if (!projectionFound) {
            reportIssue(source, options, issues, PROJECTION_UNAVAILABLE);
            firstPrompt = fromRollout.firstPrompt;
            userTextParts.push(...fromRollout.parts);
            userTextCharacters = fromRollout.characters;
            userTextBounded = fromRollout.bounded;
        }
    }

    const state = await readNativeMetadata(source, header.nativeId, options, issues);
    const title = boundHistoryText({
        value: state.title,
        limitBytes: options.fullSummaryFields ? Infinity : HISTORY_METADATA_LIMITS.customTitleBytes,
    });
    const summary = boundHistoryText({
        value: state.summary,
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
    pushBoundedField(boundedFields, "customTitle", title.bounded);
    pushBoundedField(boundedFields, "summary", summary.bounded);
    pushBoundedField(boundedFields, "firstPrompt", prompt.bounded);
    pushBoundedField(boundedFields, "allUserText", userTextBounded);
    const storageTruncatedFields: BoundedMetadataField[] = [];
    pushBoundedField(storageTruncatedFields, "customTitle", title.bounded);
    pushBoundedField(storageTruncatedFields, "summary", summary.bounded);
    pushBoundedField(storageTruncatedFields, "firstPrompt", prompt.bounded);
    const cwd = header.cwd ?? state.cwd;
    const pathArchived = source.filePath.includes(`${sep}archived_sessions${sep}`);

    return {
        metadata: {
            filePath: source.filePath,
            sessionId: header.nativeId,
            customTitle: title.value,
            summary: summary.value,
            firstPrompt: prompt.value,
            gitBranch: header.gitBranch,
            project: projectName(cwd),
            cwd,
            mtime: fileStat.mtimeMs,
            firstTimestamp,
            isSubagent: header.isSubagent,
            allUserText: userTextParts.length > 0 ? userTextParts.join(" ") : null,
            sourceHome: source.sourceHome,
            nativeId: header.nativeId,
            ...(header.parentNativeId ? { parentNativeId: header.parentNativeId } : {}),
            root: source.root,
            lastTimestamp: lastTimestamp ?? undefined,
            archived: pathArchived || state.archived === true,
            resumeMode: "native",
            boundedFields,
            storageTruncatedFields,
        },
        issues,
        complete: !issues.some((issue) => issue.message !== PROJECTION_UNAVAILABLE && blocksMetadata(issue)),
    };
}

export type CodexHistoryOperations = Pick<NativeSessionReader<"codex">, "parserVersion"> &
    Required<Pick<NativeSessionReader<"codex">, "readMetadata" | "scan" | "readRecords">>;

export function createCodexHistoryOperations(): CodexHistoryOperations {
    return {
        parserVersion: "6",
        readMetadata: readCodexMetadata,
        scan: scanCodexRecords,
        readRecords: readCodexRecords,
    };
}
