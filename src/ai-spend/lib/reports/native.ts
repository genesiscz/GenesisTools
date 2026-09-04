import { basename, dirname } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { accountIdForFile, resolveDriverRoots } from "../account-roots";
import { claudeDriver } from "../drivers/claude";
import { codexDriver } from "../drivers/codex";
import { grokDriver } from "../drivers/grok";
import { num } from "../drivers/parse-helpers";
import type { DriverRoot, DriverUsageEvent, MonitorDriver } from "../drivers/types";
import { findRecentTranscripts } from "../monitor";
import { asRecord, asString, parseJsonValue } from "./jsonl";
import type { SourceId, SpendEvent } from "./types";
import { readText } from "./walk";

const MIN_MTIME = 0;

interface ClaudeUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    iterations?: Array<{
        type?: string;
        model?: string;
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    }>;
}

function cacheCreationTokens(usage: ClaudeUsage): number {
    const nested = usage.cache_creation;

    if (nested) {
        return num(nested.ephemeral_5m_input_tokens) + num(nested.ephemeral_1h_input_tokens);
    }

    return num(usage.cache_creation_input_tokens);
}

function unwrapClaudeRecord(raw: Record<string, unknown>): Record<string, unknown> {
    const nested = asRecord(asRecord(asRecord(raw.data)?.message)?.message);
    const envelope = asRecord(asRecord(raw.data)?.message);

    if (nested && asRecord(nested.usage)) {
        return {
            ...raw,
            timestamp: envelope?.timestamp ?? raw.timestamp,
            sessionId: envelope?.sessionId ?? raw.sessionId,
            isSidechain: envelope?.isSidechain ?? raw.isSidechain,
            costUSD: envelope?.costUSD ?? raw.costUSD,
            message: nested,
        };
    }

    return raw;
}

function parseClaudeLine(line: string, file: string): SpendEvent[] {
    if (!line.includes('"usage"')) {
        return [];
    }

    const parsed = parseJsonValue(line);
    const raw = asRecord(parsed);

    if (!raw) {
        return [];
    }

    const entry = unwrapClaudeRecord(raw);
    const message = asRecord(entry.message);
    const usage = asRecord(message?.usage);

    if (!message || !usage) {
        return [];
    }

    const sessionId = asString(entry.sessionId) ?? basename(file).replace(/\.jsonl$/, "");
    const project = asString(entry.cwd) ?? "";
    const timestamp = asString(entry.timestamp) ?? "";
    const isSidechain = entry.isSidechain === true;
    const model = asString(message.model) ?? "unknown";
    const messageId = asString(message.id) ?? `${sessionId}|${timestamp}|${model}`;
    const events: SpendEvent[] = [];
    const recorded = typeof entry.costUSD === "number" ? num(entry.costUSD) : undefined;
    const inputTokens = num(usage.input_tokens as number | undefined);
    const outputTokens = num(usage.output_tokens as number | undefined);
    const cacheCreation = cacheCreationTokens(usage as ClaudeUsage);
    const cacheRead = num(usage.cache_read_input_tokens as number | undefined);

    if (inputTokens || outputTokens || cacheCreation || cacheRead) {
        events.push({
            source: "claude",
            id: messageId,
            model,
            timestamp,
            sessionId,
            project,
            inputTokens,
            outputTokens,
            cacheCreationTokens: cacheCreation,
            cacheReadTokens: cacheRead,
            recordedCostUsd: recorded,
            isSidechain,
        });
    }

    const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];

    for (const [index, rawIteration] of iterations.entries()) {
        const iteration = asRecord(rawIteration);

        if (!iteration) {
            continue;
        }

        const kind = asString(iteration.type) ?? asString(iteration.kind);

        if (kind !== "advisor_message") {
            continue;
        }

        events.push({
            source: "claude",
            id: `${messageId}:advisor:${index}`,
            model: asString(iteration.model) ?? "unknown",
            timestamp,
            sessionId,
            project,
            inputTokens: num(iteration.input_tokens as number | undefined),
            outputTokens: num(iteration.output_tokens as number | undefined),
            cacheCreationTokens: num(iteration.cache_creation_input_tokens as number | undefined),
            cacheReadTokens: num(iteration.cache_read_input_tokens as number | undefined),
            isSidechain,
        });
    }

    return events;
}

function sessionFromFile(file: string, source: SourceId): string {
    if (source === "grok") {
        return basename(dirname(file));
    }

    return basename(file).replace(/\.jsonl$/, "");
}

function projectFromFile(file: string, source: SourceId): string {
    if (source === "claude") {
        const parts = file.split("/");
        const projects = parts.lastIndexOf("projects");

        if (projects >= 0 && parts[projects + 1]) {
            return parts[projects + 1];
        }
    }

    if (source === "grok") {
        return basename(dirname(dirname(file)));
    }

    return "";
}

export interface NativeChunkOptions {
    driver: MonitorDriver;
    source: SourceId;
    /** Absolute path, for the session id and the project name. */
    file: string;
    /** Complete lines only — a chunk cut mid-line loses that line in both halves. */
    chunk: string;
    /** Codex's sticky model and cumulative totals, from the previous chunk. */
    state?: unknown;
}

export interface NativeChunkResult {
    events: SpendEvent[];
    /** Feed back as `state` for the next chunk of the same file. */
    state: unknown;
}

/**
 * Turn one chunk of ONE native transcript into events.
 *
 * Split out of the whole-file loader so the incremental series cache
 * (`events-cache.ts`) parses appended bytes with exactly this code. Two
 * parsers for the same dialect would drift, and the drift would show up as a
 * series and a report disagreeing about the same file.
 */
export function parseNativeChunk(options: NativeChunkOptions): NativeChunkResult {
    const { driver, source, file, chunk } = options;
    const events: SpendEvent[] = [];

    if (source === "claude") {
        for (const line of chunk.split("\n")) {
            events.push(...parseClaudeLine(line, file));
        }

        return { events, state: undefined };
    }

    const parser = driver.createParser({ file, state: options.state });
    const sessionId = sessionFromFile(file, source);
    const project = projectFromFile(file, source);

    for (const line of chunk.split("\n")) {
        parser.parseLine(line, (event: DriverUsageEvent) => {
            events.push({
                source,
                id: event.id,
                model: event.model,
                timestamp: event.timestamp,
                sessionId,
                project,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheCreationTokens: event.cacheCreationTokens,
                cacheReadTokens: event.cacheReadTokens,
                recordedCostUsd: event.recordedCostUsd,
                reasoningOutputTokens: event.reasoningOutputTokens,
            });
        });
    }

    return { events, state: parser.snapshot() };
}

/**
 * Which trees to read, and who owns each one.
 *
 * The reports resolve roots through the SAME `resolveDriverRoots` the monitor
 * and the series cache use, so `daily`, `monitor` and `series` cannot disagree
 * about which account a transcript belongs to.
 */
export interface LoadNativeOptions {
    home: string;
    minMtimeMs?: number;
    accounts?: readonly AccountEntry[];
    discoveredHomes?: readonly DiscoveredHome[];
}

function loadDriverFiles(driver: MonitorDriver, source: SourceId, options: LoadNativeOptions): SpendEvent[] {
    const roots = resolveDriverRoots({
        driver,
        userHome: options.home,
        accounts: options.accounts,
        discoveredHomes: options.discoveredHomes,
    });
    const files = findRecentTranscripts(
        roots.map((root) => root.path),
        options.minMtimeMs ?? MIN_MTIME,
        driver
    );
    const byPath = new Map(roots.map((root) => [root.path, root]));
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const accountId = accountIdForFile(file, roots);
        const home = byPath.get(rootOfFile(file, roots))?.home;

        for (const event of parseNativeChunk({ driver, source, file, chunk: content }).events) {
            if (accountId !== undefined) {
                event.accountId = accountId;
            }

            if (home !== undefined) {
                event.home = home;
            }

            events.push(event);
        }
    }

    return events;
}

/** The longest root the file sits under, so `home` comes from the same row `accountId` did. */
function rootOfFile(file: string, roots: readonly DriverRoot[]): string {
    let best = "";

    for (const root of roots) {
        if ((file.startsWith(`${root.path}/`) || file === root.path) && root.path.length > best.length) {
            best = root.path;
        }
    }

    return best;
}

export function loadClaudeEvents(options: LoadNativeOptions): SpendEvent[] {
    return loadDriverFiles(claudeDriver, "claude", options);
}

export function loadCodexEvents(options: LoadNativeOptions): SpendEvent[] {
    return loadDriverFiles(codexDriver, "codex", options);
}

export function loadGrokEvents(options: LoadNativeOptions): SpendEvent[] {
    return loadDriverFiles(grokDriver, "grok", options);
}

export function nativePriceCandidates(source: SourceId, model: string): string[] {
    if (source === "claude") {
        return claudeDriver.priceCandidates(model);
    }

    if (source === "codex") {
        return codexDriver.priceCandidates(model);
    }

    if (source === "grok") {
        return grokDriver.priceCandidates(model);
    }

    return [model];
}
