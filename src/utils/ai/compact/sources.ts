import { dirname } from "node:path";
import {
    claudeHistoryReader,
    codexHistoryReader,
    grokHistoryReader,
} from "@genesiscz/utils/agent-sessions/compact-readers";
import type { NativeHistoryEntry, NativeSessionReader } from "@genesiscz/utils/agent-sessions/types";
import { logger } from "@genesiscz/utils/logger";
import { detectCompactFormat, parseCompactDocument } from "./format";
import { type MessageRow, pairRows } from "./pairing";
import type { CompactFormat, CompactMessage } from "./schema";

const log = logger.child({ component: "ai:compact:sources" });

export const COMPACT_SOURCES = ["auto", "jsonl", "claude", "codex", "grok"] as const;
export type CompactSource = (typeof COMPACT_SOURCES)[number];

export const NATIVE_COMPACT_SOURCES = ["claude", "codex", "grok"] as const;
export type NativeCompactSource = (typeof NATIVE_COMPACT_SOURCES)[number];

export function parseCompactSource(value: unknown): CompactSource {
    if (value === undefined || value === null || value === "") {
        return "auto";
    }

    if (typeof value === "string" && (COMPACT_SOURCES as readonly string[]).includes(value)) {
        return value as CompactSource;
    }

    throw new Error(`Unknown compact source '${String(value)}'. Valid: ${COMPACT_SOURCES.join("|")}`);
}

export function isNativeSource(source: CompactSource): source is NativeCompactSource {
    return (NATIVE_COMPACT_SOURCES as readonly string[]).includes(source);
}

const NATIVE_READERS: Record<NativeCompactSource, NativeSessionReader> = {
    claude: claudeHistoryReader,
    codex: codexHistoryReader,
    grok: grokHistoryReader,
};

/**
 * Turns the reader's flat entry list into message rows.
 *
 * Native entries carry no tool ids, so a `result` binds to the most recent unresolved `call` of
 * the same tool name. That is how the native files themselves read, and it keeps the pairing rule
 * (a drop never orphans a result) meaningful for `--source claude|codex|grok`.
 */
export function nativeEntriesToRows(entries: NativeHistoryEntry[]): MessageRow[] {
    const rows: MessageRow[] = [];
    const open = new Map<string, string>();
    let calls = 0;

    for (const entry of entries) {
        if (entry.role === "tool" && entry.toolEvent === "call") {
            const name = entry.tool ?? "tool";
            calls += 1;
            const id = `n${calls}`;
            open.set(name, id);
            rows.push({
                role: "assistant",
                content: "",
                toolCalls: [{ id, name, input: entry.inputText ?? entry.text }],
            });
            continue;
        }

        if (entry.role === "tool") {
            const name = entry.tool ?? "tool";
            const id = open.get(name);
            open.delete(name);
            rows.push({ role: "tool", content: entry.text, toolCallId: id, name });
            continue;
        }

        rows.push({ role: entry.role === "thinking" ? "assistant" : entry.role, content: entry.text });
    }

    return rows;
}

function sourceFor(reader: NativeSessionReader, filePath: string) {
    const roots = reader.roots();
    const root = roots.find((candidate) => filePath.startsWith(`${candidate}/`)) ?? dirname(filePath);
    return {
        kind: reader.kind,
        root,
        sourceHome: dirname(root),
        filePath,
        dataPaths: [filePath],
        metadataPaths: [],
    };
}

export async function readNativeTranscript(options: {
    source: NativeCompactSource;
    filePath: string;
    signal?: AbortSignal;
}): Promise<CompactMessage[]> {
    const reader = NATIVE_READERS[options.source];
    log.info({ source: options.source, filePath: options.filePath }, "Reading a native transcript for compaction");
    const transcript = await reader.read(sourceFor(reader, options.filePath), options.signal);
    if (transcript.issues.length) {
        log.warn({ issues: transcript.issues }, "Native transcript reader reported issues");
    }

    log.info(
        { source: options.source, entries: transcript.entries.length },
        "Native transcript read; converting to compact messages"
    );
    return pairRows(nativeEntriesToRows(transcript.entries));
}

/**
 * The one input door. `--source auto` detects the shape; a native source needs a file path,
 * because the agent-sessions readers own that parsing and nothing here re-implements it.
 */
export async function loadCompactMessages(options: {
    text: string;
    filePath?: string;
    source: CompactSource;
    signal?: AbortSignal;
}): Promise<{ format: CompactFormat; messages: CompactMessage[] }> {
    const detected = detectCompactFormat(options.text);
    if (isNativeSource(options.source) || (options.source === "auto" && detected === "native")) {
        const native = isNativeSource(options.source) ? options.source : "claude";
        const filePath = options.filePath;
        if (!filePath) {
            throw new Error(`compact --source ${native} needs a file path; a native transcript is read from disk.`);
        }

        const messages = await readNativeTranscript({ source: native, filePath, signal: options.signal });
        return { format: "native", messages };
    }

    const format = options.source === "jsonl" && detected === "native" ? "generic-jsonl" : detected;
    log.debug({ source: options.source, detected, format }, "Compact input format resolved");
    return { format, messages: parseCompactDocument(options.text, format) };
}
