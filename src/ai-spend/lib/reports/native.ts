import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { logger } from "@genesiscz/utils/logger";
import { resolveDriverRoots, rootForFile } from "../account-roots";
import { spendDriver } from "../drivers";
import { claudeDriver } from "../drivers/claude";
import { codexDriver } from "../drivers/codex";
import { grokDriver } from "../drivers/grok";
import { num } from "../drivers/parse-helpers";
import type { AgentId, DriverRoot, DriverUsageEvent, MonitorDriver, SpendLayout } from "../drivers/types";
import { findRecentTranscripts } from "../monitor";
import { prof } from "../prof";
import { asRecord, asString, parseJsonValue } from "./jsonl";
import type { SourceId, SpendEvent } from "./types";
import { readBytes, readText } from "./walk";

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

    // `session_id` names the session that WROTE the line. A fork or `--resume` copies the parent's
    // history into its own file and restamps `sessionId`, but keeps the parent's `session_id`: so the
    // copied lines stay the parent's, and a fork bills only its own turns (1351539e: 927 of its 1,052
    // usage lines were copies of 44bc9984's). On every other line the two fields agree.
    const sessionId = asString(entry.session_id) ?? asString(entry.sessionId) ?? basename(file).replace(/\.jsonl$/, "");
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
    const cacheCreation1h = num((usage as ClaudeUsage).cache_creation?.ephemeral_1h_input_tokens);
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
            ...(cacheCreation1h > 0 ? { cacheCreation1hTokens: Math.min(cacheCreation1h, cacheCreation) } : {}),
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

/** A driver whose transcripts name their session and project in the path (`MonitorDriver.spendLayout`). */
type PathLayout = Extract<SpendLayout, { kind: "path" }>;

export interface NativeChunkOptions {
    driver: MonitorDriver;
    source: NativeSourceId;
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
    return nativeRead(options.source).parseChunk(options);
}

function parseClaudeChunk({ file, chunk }: NativeChunkOptions): NativeChunkResult {
    const events: SpendEvent[] = [];

    for (const line of chunk.split("\n")) {
        events.push(...parseClaudeLine(line, file));
    }

    return { events, state: undefined };
}

function parseDriverChunk(options: NativeChunkOptions, layout: PathLayout): NativeChunkResult {
    const { driver, source, file, chunk } = options;
    const events: SpendEvent[] = [];
    const parser = driver.createParser({ file, state: options.state });
    const sessionId = layout.session(file);
    const project = layout.project(file);

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
                ...(event.cacheCreation1hTokens ? { cacheCreation1hTokens: event.cacheCreation1hTokens } : {}),
                cacheReadTokens: event.cacheReadTokens,
                ...(event.aggregate ? { aggregate: true } : {}),
                recordedCostUsd: event.recordedCostUsd,
                reasoningOutputTokens: event.reasoningOutputTokens,
                serviceTier: event.serviceTier,
                codex: event.codex,
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
    /**
     * Skip Claude transcripts that cannot hold this session's events: a file
     * whose text never mentions the id, unless the id is its own stem (the
     * parser falls back to the stem when a line carries no `sessionId`). The
     * caller still filters events by id; this only saves the JSON parse.
     */
    sessionId?: string;
}

/** Claude's pre-`subagents/` layout: sidechain transcripts beside the session file. */
const LEGACY_AGENT_PREFIX = "agent-";

interface DriverFilesOptions {
    driver: MonitorDriver;
    source: NativeSourceId;
    roots: DriverRoot[];
    files: string[];
    sessionId?: string;
}

function driverRoots(driver: MonitorDriver, options: LoadNativeOptions): DriverRoot[] {
    return resolveDriverRoots({
        driver,
        userHome: options.home,
        accounts: options.accounts,
        discoveredHomes: options.discoveredHomes,
    });
}

/**
 * A Claude file whose events can carry `sessionId` only through the text of
 * its lines, so a file that never mentions the id cannot contribute one.
 * The session's own file and everything under `<project>/<id>/` always can.
 */
function mustMentionSession(file: string, sessionId: string): boolean {
    if (basename(file) === `${sessionId}.jsonl`) {
        return false;
    }

    return !file.includes(`${sep}${sessionId}${sep}`);
}

const USAGE_NEEDLE = Buffer.from('"usage"');
const NEWLINE = 0x0a;

/**
 * `parseNativeChunk`'s Claude branch for a whole file held as BYTES: the same
 * lines, the same `"usage"` filter and the same `parseClaudeLine`, but only
 * the lines that can carry usage are ever decoded. A newline byte never
 * occurs inside a UTF-8 sequence, so byte lines are exactly the string lines.
 * Measured on a 172 MB session plus its subagents (525 MB): 360 ms as one
 * decoded string split into lines, 250 ms this way.
 */
function parseClaudeBytes(bytes: Buffer, file: string): SpendEvent[] {
    const events: SpendEvent[] = [];
    let hit = bytes.indexOf(USAGE_NEEDLE);

    while (hit !== -1) {
        const start = bytes.lastIndexOf(NEWLINE, hit) + 1;
        const newline = bytes.indexOf(NEWLINE, hit);
        const end = newline === -1 ? bytes.length : newline;

        for (const event of parseClaudeLine(bytes.toString("utf8", start, end), file)) {
            events.push(event);
        }

        if (newline === -1) {
            break;
        }

        hit = bytes.indexOf(USAGE_NEEDLE, newline);
    }

    return events;
}

interface ParseFileOptions {
    driver: MonitorDriver;
    source: NativeSourceId;
    file: string;
    sessionId?: string;
}

function parseDriverFile(options: ParseFileOptions, layout: PathLayout): SpendEvent[] | null {
    const { driver, source, file } = options;
    const content = readText(file);

    return content === null ? null : parseDriverChunk({ driver, source, file, chunk: content }, layout).events;
}

function parseClaudeFile({ file, sessionId }: ParseFileOptions): SpendEvent[] | null {
    const bytes = readBytes(file);

    if (bytes === null) {
        return null;
    }

    if (sessionId !== undefined && mustMentionSession(file, sessionId) && !bytes.includes(sessionId)) {
        return null;
    }

    return parseClaudeBytes(bytes, file);
}

function parseDriverFiles(options: DriverFilesOptions): SpendEvent[] {
    const { driver, source, roots, files, sessionId } = options;
    const events: SpendEvent[] = [];

    for (const file of files) {
        const parsed = nativeRead(source).parseFile({ driver, source, file, sessionId });

        if (parsed === null) {
            continue;
        }

        // One lookup for both fields: `home` must come from the same row
        // `accountId` did, and a second selector is how the two drift apart.
        const root = rootForFile(file, roots);
        const accountId = root?.accountId;
        const home = root?.home;

        for (const event of parsed) {
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

function loadDriverFiles(driver: MonitorDriver, source: NativeSourceId, options: LoadNativeOptions): SpendEvent[] {
    const roots = driverRoots(driver, options);
    const files = prof.measure(`${source}:discover`, () =>
        findRecentTranscripts(
            roots.map((root) => root.path),
            options.minMtimeMs ?? MIN_MTIME,
            driver
        )
    );
    // The file count tells a slow run from a big one: the same seconds mean something different over 50 files and 5000.
    prof.mark(`${source}:files=${files.length}`);

    return prof.measure(`${source}:parse`, () =>
        parseDriverFiles({ driver, source, roots, files, sessionId: options.sessionId })
    );
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

export type NativeSourceId = Extract<SourceId, AgentId>;

function readDirEntries(dir: string): Dirent[] {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        logger.debug({ err, dir }, "ai-spend: unreadable dir skipped");
        return [];
    }
}

function modifiedSince(file: string, minMtimeMs: number): boolean {
    try {
        return statSync(file).mtimeMs >= minMtimeMs;
    } catch (err) {
        logger.debug({ err, file }, "ai-spend: stat failed");
        return false;
    }
}

interface SessionFilesOptions {
    driver: MonitorDriver;
    source: NativeSourceId;
    roots: string[];
    sessionId: string;
    minMtimeMs: number;
}

/**
 * Claude names a session's files after its id: `<project>/<id>.jsonl`, its
 * subagents under `<project>/<id>/`, and (older builds) `agent-*.jsonl` beside
 * it. Only the project directories holding the id are listed, in readdir
 * order, so these files arrive in the order the full walk meets them.
 *
 * What this cannot see: a copy of one of the session's messages inside
 * ANOTHER session's file (a resumed or forked session repeats the history it
 * came from, under the same message ids). The full walk keeps whichever copy
 * it met first, so there a message could land on the other session; here the
 * session's own copy always counts.
 */
function claudeSessionFiles(options: SessionFilesOptions): string[] | undefined {
    const { driver, roots, sessionId, minMtimeMs } = options;
    const stemName = `${sessionId}.jsonl`;
    const found = new Set<string>();
    let located = false;

    for (const root of roots) {
        for (const project of readDirEntries(root)) {
            if (!project.isDirectory()) {
                continue;
            }

            const dir = join(root, project.name);

            if (!existsSync(join(dir, stemName)) && !existsSync(join(dir, sessionId))) {
                continue;
            }

            located = true;

            for (const entry of readDirEntries(dir)) {
                const full = join(dir, entry.name);

                if (entry.isDirectory()) {
                    // The full walk enters this directory two levels below the root.
                    if (entry.name === sessionId && driver.maxDepth >= 2) {
                        const nested = { ...driver, maxDepth: driver.maxDepth - 2 };

                        for (const file of findRecentTranscripts([full], minMtimeMs, nested)) {
                            found.add(file);
                        }
                    }

                    continue;
                }

                if (!entry.isFile() || !driver.isTranscript(entry.name)) {
                    continue;
                }

                if (entry.name !== stemName && !entry.name.startsWith(LEGACY_AGENT_PREFIX)) {
                    continue;
                }

                if (modifiedSince(full, minMtimeMs)) {
                    found.add(full);
                }
            }
        }
    }

    return located ? [...found] : undefined;
}

/**
 * Codex and Grok take the session id from the PATH (`PathLayout.session`), so
 * matching names is exact: a file named otherwise cannot yield an event of
 * this session. Located is decided before the mtime cut, so a session older
 * than `--since` still counts as found (with no events) instead of sending
 * the caller to a full scan.
 */
function pathSessionFiles(options: SessionFilesOptions, layout: PathLayout): string[] | undefined {
    const { driver, roots, sessionId, minMtimeMs } = options;
    const named = findRecentTranscripts(roots, MIN_MTIME, driver, (file) => layout.session(file) === sessionId);

    if (named.length === 0) {
        return undefined;
    }

    return named.filter((file) => modifiedSince(file, minMtimeMs));
}

/**
 * How the reports read one agent's native transcripts, one entry per agent. Claude has its own parser (it dedups on
 * the message id and pre-filters a file's bytes for one session); Codex and Grok go through their driver's line
 * parser and take the session id from the path.
 */
interface NativeRead {
    driver: MonitorDriver;
    parseChunk(options: NativeChunkOptions): NativeChunkResult;
    parseFile(options: ParseFileOptions): SpendEvent[] | null;
    /** The files of one session; undefined when no file of this agent is named after it. */
    sessionFiles(options: SessionFilesOptions): string[] | undefined;
}

function pathNamedRead(driver: MonitorDriver, layout: PathLayout): NativeRead {
    return {
        driver,
        parseChunk: (options) => parseDriverChunk(options, layout),
        parseFile: (options) => parseDriverFile(options, layout),
        sessionFiles: (options) => pathSessionFiles(options, layout),
    };
}

/** The reader of a driver whose rows carry their session and project (`spendLayout.kind` "rows"). */
function rowNamedRead(driver: MonitorDriver): NativeRead {
    return { driver, parseChunk: parseClaudeChunk, parseFile: parseClaudeFile, sessionFiles: claudeSessionFiles };
}

/** How ai-spend reads a source's transcripts, chosen by its driver's `spendLayout`. */
function nativeRead(source: NativeSourceId): NativeRead {
    const driver = spendDriver(source);
    const layout = driver.spendLayout;

    return layout.kind === "rows" ? rowNamedRead(driver) : pathNamedRead(driver, layout);
}

/** Whether ai-spend reads this source from a coding agent's own transcripts (through a `MonitorDriver`). */
export function isNativeSource(source: SourceId): source is NativeSourceId {
    return isAccountProviderAlias(source);
}

/**
 * The transcripts of ONE session, found by name instead of reading every
 * transcript and filtering by id afterwards.
 *
 * Returns `undefined` when no file of this agent is named after the session.
 * For Codex and Grok that means the agent has no such session; for Claude it
 * means the id may still live inside another file (a workflow run id, say),
 * which only the caller can decide to scan for.
 */
export function loadNativeSessionEvents(
    source: NativeSourceId,
    options: LoadNativeOptions & { sessionId: string }
): SpendEvent[] | undefined {
    const { sessionId } = options;

    if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId)) {
        return undefined;
    }

    const { driver, sessionFiles } = nativeRead(source);
    const roots = driverRoots(driver, options);
    const files = sessionFiles({
        driver,
        source,
        roots: roots.map((root) => root.path),
        sessionId,
        minMtimeMs: options.minMtimeMs ?? MIN_MTIME,
    });

    if (files === undefined) {
        return undefined;
    }

    return parseDriverFiles({ driver, source, roots, files, sessionId });
}

export function nativePriceCandidates(source: NativeSourceId, model: string): string[] {
    return spendDriver(source).priceCandidates(model);
}
