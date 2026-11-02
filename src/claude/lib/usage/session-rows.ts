import { cleanPromptText } from "@app/claude/lib/cmux/sessions";
import { getSessionListing, type SessionMetadataRecord } from "@app/claude/lib/history/search";
import { loadPins, type PinHost, type SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import {
    type ClaudeTailUsage,
    emptyClaudeTailUsage,
    parseClaudeTailUsage,
} from "@genesiscz/utils/agent-sessions/readers/claude-tail-usage";
import { readSessionsContinuedIn } from "@genesiscz/utils/agent-sessions/session-backward";
import { liveClaudeSessionIds } from "@genesiscz/utils/claude/peer-message";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import { loadAllSessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { collapsePath } from "@genesiscz/utils/paths";
import { profiler } from "@genesiscz/utils/profile";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { CACHE_TTL_MS, type CacheStatus, computeCacheStatus } from "./cache-clock";

export {
    CACHE_TTL_MS,
    type CacheStatus,
    CODEX_CACHE_TTL_MS,
    COOLING_REMAINING_MS,
    COOLING_THRESHOLD_MS,
    CRITICAL_REMAINING_MS,
    CRITICAL_THRESHOLD_MS,
    computeCacheStatus,
    GROK_CACHE_TTL_MS,
} from "./cache-clock";

const TAIL_BATCH_SIZE = 20;
/** First slice. Grows up to TAIL_MAX_BYTES until a user/assistant timestamp is found. */
const TAIL_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 1024 * 1024;

export interface SessionRow {
    sessionId: string;
    title: string | null;
    cwd: string;
    cwdShort: string;
    project: string | null;
    /** The branch the transcript recorded (history index); lets the hub map a session to a branch, not only a folder. */
    gitBranch?: string | null;
    mtime: number;
    /** Last main-thread user/assistant timestamp (statusline @HH:MM:SS). Falls back to mtime. */
    lastCacheAt: number;
    model: string | null;
    modelSwitched: boolean;
    cacheStatus: CacheStatus;
    cacheTtlSec: number;
    /** Full prompt-cache lifetime in seconds (3600 Claude, 1800 Codex). */
    cacheLifetimeSec: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    /**
     * Context-window size: last real turn's input + cache tokens (output excluded — it
     * never sits in the window). After a compaction with no turn yet, this is the exact
     * `compactMetadata.postTokens` from the compact_boundary record instead.
     */
    contextTokens: number;
    /**
     * True when a compact_boundary follows the last real model turn (contextTokens = postTokens), and when the
     * transcript ended by continuing in another session (`continuedIn`): its cache is then nothing to keep warm.
     */
    compacted: boolean;
    /**
     * The session this transcript continues in. Claude Code (2.1.296) writes a final `continued-in` line when it hands
     * the conversation to a background session with a new id: the ← key on the prompt (it opens the agents view) or
     * `/background`. The old id then keeps a cache clock nobody uses (2026-10-14: a banner counted 4578e02a down to
     * "1 min left" half an hour after ← had moved it to f2899264, where `/compact` then ran).
     */
    continuedIn: string | null;
    /** Timestamp of the last real typed user message (not tool results, not compact summaries). */
    lastUserAt: number | null;
    /**
     * Account this session bills, from the SessionStart pin journal. `null` covers
     * both "no pin recorded" and a plain keychain launch (pin with account null).
     */
    account: string | null;
    /** The app that hosted the session (a T3 Code thread), from the same pin; null when none did or no pin says. */
    host: PinHost | null;
    /** Recorded cmux location from the refs journal — where the session started, unverified. */
    cmux: SessionCmuxLocation | null;
    /**
     * Whether a claude process still runs this session (`~/.claude/sessions` registry). null when the
     * registry could not be read. The Genesis monitor skips cache banners for `false`: a session whose
     * process exited cannot be resumed from its pane, and those were 80 of 203 banners in 40 h (2026-10-23).
     */
    alive: boolean | null;
    filePath: string;
}

export interface SessionCmuxLocation {
    workspaceId: string | null;
    workspaceRef: string | null;
    paneRef: string | null;
    surfaceId: string | null;
    surfaceRef: string | null;
    windowRef: string | null;
    /** When the location was journaled; staleness is the consumer's call. */
    at: number;
}

interface TailUsage extends ClaudeTailUsage {
    /** The session this transcript continued in (`NativeSessionReader.continuedIn`). */
    continuedIn: string | null;
}

export interface ListSessionRowsOptions {
    /** Keep rows with mtime within this many hours. Omitted = no time filter. */
    hours?: number;
    /** If the hours window has fewer rows, append older sessions by mtime. */
    minRows?: number;
    /**
     * Keep only the sessions this host app ran, by its kind in the pin journal (`t3`). The filter runs before the
     * window and the top-up, so `minRows` counts hosted sessions and an older hosted one is appended.
     */
    host?: string;
    excludeSubagents?: boolean;
    /** Exact transcript paths; forwarded to the catalog before any tail reads. */
    filePaths?: string[];
    now?: number;
    /**
     * `false` skips the transcript tail reads, and every token, model and cache field then
     * reads as empty. For listings that show who and where, not what a session costs (the
     * inbox, the timeline): the tails were 68 ms of a 300 ms inbox refresh.
     */
    withUsage?: boolean;
    /** Passed to `getSessionListing`: reuse another process's refresh of the same scope. */
    maxDiscoveryAgeMs?: number;
    /** Passed to `getSessionListing`: `false` reads the index with no refresh. */
    refresh?: boolean;
    /** Which session ids have a running claude process; tests inject it. Defaults to the registry. */
    liveSessionIds?: () => Set<string> | null;
}

function simplifyModel(model: string): string {
    if (model.includes("fable")) {
        return "fable";
    }

    if (model.includes("opus")) {
        return "opus";
    }

    if (model.includes("sonnet")) {
        return "sonnet";
    }

    if (model.includes("haiku")) {
        return "haiku";
    }

    return model.split("-").pop() ?? model;
}

function emptyTailUsage(): TailUsage {
    return { ...emptyClaudeTailUsage(), continuedIn: null };
}

function isNullableNumber(value: unknown): value is number | null {
    return value === null || typeof value === "number";
}

function isTailUsage(usage: unknown): usage is TailUsage {
    if (!isObject(usage)) {
        return false;
    }

    return (
        typeof usage.totalTokens === "number" &&
        typeof usage.cacheReadTokens === "number" &&
        typeof usage.cacheCreateTokens === "number" &&
        typeof usage.inputTokens === "number" &&
        (usage.model === null || typeof usage.model === "string") &&
        (usage.prevModel === null || typeof usage.prevModel === "string") &&
        isNullableNumber(usage.lastCacheAt) &&
        isNullableNumber(usage.lastUserAt) &&
        isNullableNumber(usage.compactedPostTokens) &&
        // Required, not defaulted: a tail cached before this field existed may end in `continued-in`.
        (usage.continuedIn === null || typeof usage.continuedIn === "string")
    );
}

/**
 * Tail usage by session file, valid while the file's identity (inode, size, mtime, ctime) is unchanged: the result
 * depends only on the file's last bytes. A listing reads the tail of every session it lists, and most of them are
 * idle; a resident process (the hub server answers the agents tree and the usage daemon's rows) re-read them all on
 * every call (`claude-sessions tail` 340 ms of a 2.6 s agents call, 2026-10-08). Kept on disk too, so a new
 * process re-parses only the transcripts that changed: a fresh `ai usage sessions` spent 327 ms per run in
 * `parseTailLines`, 38% of its JavaScript time, on tails no one had written to since the last run (`tools ts
 * profile`, 2026-10-12). Bump the version whenever `parseClaudeTailUsage` or `TailUsage` changes what an entry
 * means. Version 3 (2026-10-30): `model` and `prevModel` hold the transcript's model ids, simplified when a row is
 * built, and `continuedIn` comes from the Claude reader.
 */
const tailCache = new FileIdentityCache<TailUsage>({
    // Above the transcripts one listing reads (2,404 here on 2026-10-12); about 450 bytes each on disk.
    limit: 20_000,
    persist: {
        path: () => toolDataDir("claude", "cache", "session-tail-usage.json"),
        version: 3,
        isValue: isTailUsage,
    },
});

/** A new process, as far as the tail cache knows: the next listing reads the saved file again. For tests. */
export function __forgetTailCacheForTests(): void {
    tailCache.forget();
}

/**
 * The tail usage of each file, from the cache while a file is unchanged. The files read again also ask the Claude
 * reader which session each continued in (one discovery for all of them); when that read fails, their usage is
 * returned without a successor and is not cached, so the next listing asks again.
 */
/** The uncached tails, `TAIL_BATCH_SIZE` files at a time so a cold listing does not open every file at once. */
async function readUncachedTails(filePaths: readonly string[]): Promise<{ usage: ClaudeTailUsage; read: boolean }[]> {
    const reads: { usage: ClaudeTailUsage; read: boolean }[] = [];

    for (let i = 0; i < filePaths.length; i += TAIL_BATCH_SIZE) {
        const batch = filePaths.slice(i, i + TAIL_BATCH_SIZE);
        reads.push(...(await Promise.all(batch.map((filePath) => extractTailUsageUncached(filePath)))));
    }

    return reads;
}

async function extractTailUsages(filePaths: readonly string[]): Promise<TailUsage[]> {
    // The identity comes first: a write after it leaves a newer one, and the next call reads the tail again.
    const identities = filePaths.map((filePath) => fileIdentity(filePath));
    const usages: (TailUsage | undefined)[] = filePaths.map((filePath, index) => {
        const cached = tailCache.get(filePath, identities[index]);
        return cached ? { ...cached } : undefined;
    });
    const misses = filePaths.filter((_, index) => usages[index] === undefined);

    if (misses.length === 0) {
        return usages.map((usage) => usage ?? emptyTailUsage());
    }

    const [reads, successors] = await Promise.all([
        readUncachedTails(misses),
        readSessionsContinuedIn({ kind: "claude", transcriptPaths: misses }).catch((err) => {
            logger.warn({ err, files: misses.length }, "[sessions] continued-in pointers unreadable; not caching");
            return null;
        }),
    ]);
    const readByPath = new Map(misses.map((filePath, index) => [filePath, reads[index]]));

    return filePaths.map((filePath, index) => {
        const cached = usages[index];

        if (cached) {
            return cached;
        }

        const read = readByPath.get(filePath);
        const usage: TailUsage = {
            ...(read?.usage ?? emptyClaudeTailUsage()),
            continuedIn: successors?.get(filePath) ?? null,
        };
        const identity = identities[index];

        if (identity && read?.read && successors) {
            tailCache.set(filePath, identity, { ...usage });
        }

        return usage;
    });
}

/** The tail usage read and parsed with no cache. Exported for `scripts/benchmarks/fs/read-child.ts`. */
export async function extractTailUsageUncached(filePath: string): Promise<{ usage: ClaudeTailUsage; read: boolean }> {
    const fallback = emptyClaudeTailUsage();

    try {
        const size = Number(Bun.file(filePath).size) || 0;
        let bytes = TAIL_BYTES;
        let parsed = fallback;

        for (;;) {
            const lines = await readTailBytes(filePath, bytes);
            parsed = parseClaudeTailUsage(lines, filePath);

            const haveClock = parsed.lastCacheAt != null;
            const haveUsage = parsed.model != null;
            const haveUser = parsed.lastUserAt != null;

            if ((haveClock && haveUsage && haveUser) || size <= 0 || bytes >= size) {
                return { usage: parsed, read: true };
            }

            if (bytes >= TAIL_MAX_BYTES) {
                // A cap that hides a field must say so: `lastUserAt` stayed null for a session whose newest prompt sat
                // 1.4 MB from the end, and nothing in the log said why (2026-10-25).
                logger.info(
                    {
                        filePath,
                        capBytes: TAIL_MAX_BYTES,
                        size,
                        missing: [!haveClock && "lastCacheAt", !haveUsage && "model", !haveUser && "lastUserAt"].filter(
                            Boolean
                        ),
                    },
                    "[sessions] tail read stopped at its cap; the missing fields stay empty for this session"
                );
                return { usage: parsed, read: true };
            }

            const next = Math.min(TAIL_MAX_BYTES, bytes * 2, size);

            if (next <= bytes) {
                return { usage: parsed, read: true };
            }

            bytes = next;
        }
    } catch (err) {
        logger.debug({ err, filePath }, "session tail read failed");
        return { usage: fallback, read: false };
    }
}

interface RowJoins {
    accounts: Map<string, string | null>;
    hosts: Map<string, PinHost>;
    cmux: Map<string, SessionCmuxLocation>;
    live: Set<string> | null;
}

/** A record's session id: the indexed one, else the transcript's file name. */
function recordSessionId(record: SessionMetadataRecord): string {
    return record.sessionId ?? record.filePath.split("/").pop()?.replace(".jsonl", "") ?? "";
}

function buildRow(record: SessionMetadataRecord, usage: TailUsage, now: number, joins: RowJoins): SessionRow {
    const cwd = record.cwd ?? "(unknown)";
    const lastCacheAt = usage.lastCacheAt ?? record.mtime;
    const { status, ttlSec } = computeCacheStatus(lastCacheAt, now);
    const sessionId = recordSessionId(record);
    const model = usage.model ? simplifyModel(usage.model) : null;
    const prevModel = usage.prevModel ? simplifyModel(usage.prevModel) : null;

    return {
        sessionId,
        title:
            cleanPromptText(record.customTitle) ??
            cleanPromptText(record.summary) ??
            cleanPromptText(record.firstPrompt) ??
            null,
        cwd,
        cwdShort: collapsePath(cwd),
        project: record.project,
        gitBranch: record.gitBranch,
        mtime: record.mtime,
        lastCacheAt,
        model,
        modelSwitched: model !== null && prevModel !== null && model !== prevModel,
        cacheStatus: status,
        cacheTtlSec: ttlSec,
        cacheLifetimeSec: Math.ceil(CACHE_TTL_MS / 1000),
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreateTokens: usage.cacheCreateTokens,
        contextTokens: usage.compactedPostTokens ?? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens,
        compacted: usage.compactedPostTokens !== null || usage.continuedIn !== null,
        continuedIn: usage.continuedIn,
        lastUserAt: usage.lastUserAt,
        account: joins.accounts.get(sessionId.toLowerCase()) ?? null,
        host: joins.hosts.get(sessionId.toLowerCase()) ?? null,
        cmux: joins.cmux.get(sessionId.toLowerCase()) ?? null,
        alive: joins.live ? joins.live.has(sessionId.toLowerCase()) : null,
        filePath: record.filePath,
    };
}

/**
 * Same row math as the usage TUI Sessions tab. `hours` is applied here because
 * `getSessionListing` has no time parameter. COLD rows inside the window stay.
 */
export interface SessionRowTimings {
    listingMs: number;
    tailMs: number;
    /** Pin + cmux-refs journal reads. */
    joinMs: number;
    totalMs: number;
    records: number;
}

/**
 * The oldest transcript mtime a host-filtered listing must read, or null when no session ran on that host. The
 * SessionStart hook writes a pin before the session writes its transcript, so a hosted transcript is at least as new
 * as its pin. Every hosted transcript is then at least as new as the oldest hosted pin, and the `minRows` newest
 * hosted transcripts are at least as new as the `minRows`-th newest hosted pin.
 */
export function hostedMtimeFloor(input: {
    pinTimes: readonly number[];
    windowFrom?: number;
    minRows?: number;
}): number | null {
    if (input.pinTimes.length === 0) {
        return null;
    }

    const newestFirst = [...input.pinTimes].sort((a, b) => b - a);

    if (input.windowFrom === undefined) {
        return newestFirst[newestFirst.length - 1];
    }

    if (input.minRows === undefined || input.minRows <= 0) {
        return input.windowFrom;
    }

    return Math.min(input.windowFrom, newestFirst[Math.min(input.minRows, newestFirst.length) - 1]);
}

/**
 * What the listing reads: the window with its SQL top-up, everything (`{}`), or nothing (null). The top-up (`newest`)
 * counts every session, so with a host filter it would miss older HOSTED ones; that read starts at the hosted pins'
 * floor instead, which keeps the refresh and the hydration bounded.
 */
function listingBounds(input: {
    windowFrom: number | undefined;
    minRows: number | undefined;
    hostedPinTimes: readonly number[] | null;
}): { mtimeFrom?: number; newest?: number } | null {
    if (input.hostedPinTimes === null) {
        return input.windowFrom === undefined ? {} : { mtimeFrom: input.windowFrom, newest: input.minRows };
    }

    const floor = hostedMtimeFloor({
        pinTimes: input.hostedPinTimes,
        windowFrom: input.windowFrom,
        minRows: input.minRows,
    });

    return floor === null ? null : { mtimeFrom: floor };
}

export async function listSessionRowsWithTimings(
    opts: ListSessionRowsOptions = {}
): Promise<{ rows: SessionRow[]; timings: SessionRowTimings }> {
    const prof = profiler.scope("claude-sessions");
    const started = performance.now();
    const now = opts.now ?? Date.now();
    const readPins = (): Promise<Map<string, SessionPin>> => loadPins({ readOnly: true }).catch(() => new Map());
    // The host lives in the pin journal only, so a host filter reads it before the window is cut. The listing is
    // Claude's, so only Claude pins count: a newer Codex pin would raise the read's floor past an older Claude one.
    const hostPins =
        opts.host === undefined
            ? null
            : await loadPins({ readOnly: true, provider: "claude" }).catch(() => new Map<string, SessionPin>());
    const hostedPins = hostPins ? [...hostPins].filter(([, pin]) => pin.host?.kind === opts.host) : null;
    const hosted = hostedPins ? new Set(hostedPins.map(([sessionId]) => sessionId.toLowerCase())) : null;
    // The window and the top-up go down to the refresh and the SQL read; the filters below then keep exactly what
    // they kept before.
    const bounds = listingBounds({
        windowFrom: opts.hours === undefined ? undefined : now - opts.hours * 60 * 60 * 1000,
        minRows: opts.minRows,
        hostedPinTimes: hostedPins ? hostedPins.map(([, pin]) => pin.at) : null,
    });
    const result =
        bounds === null
            ? null
            : await prof.measureAsync("listing", () =>
                  getSessionListing({
                      excludeSubagents: opts.excludeSubagents ?? true,
                      ...(opts.filePaths === undefined ? {} : { filePaths: opts.filePaths }),
                      ...bounds,
                      ...(opts.maxDiscoveryAgeMs === undefined ? {} : { maxDiscoveryAgeMs: opts.maxDiscoveryAgeMs }),
                      ...(opts.refresh === undefined ? {} : { refresh: opts.refresh }),
                  })
              );
    const listingMs = performance.now() - started;
    const listed = result?.sessions ?? [];
    const sessions = hosted ? listed.filter((r) => hosted.has(recordSessionId(r).toLowerCase())) : listed;
    const cutoff = opts.hours === undefined ? Number.NEGATIVE_INFINITY : now - opts.hours * 60 * 60 * 1000;
    const inWindow = sessions.filter((r) => r.mtime >= cutoff);
    const need = opts.minRows !== undefined ? Math.max(0, opts.minRows - inWindow.length) : 0;
    const extra =
        need === 0
            ? []
            : sessions
                  .filter((r) => r.mtime < cutoff)
                  .sort((a, b) => b.mtime - a.mtime)
                  .slice(0, need);
    const records = inWindow.concat(extra);
    const usages: TailUsage[] = [];
    const tailStarted = performance.now();

    await prof.measureAsync("tail", async () => {
        if (opts.withUsage === false) {
            usages.push(...records.map(() => emptyTailUsage()));
            return;
        }

        await tailCache.load();

        usages.push(...(await extractTailUsages(records.map((r) => r.filePath))));

        // `refresh: false` is a diagnostic (a dry run, `hub rules test`): it may read and compute, never write.
        if (opts.refresh !== false) {
            await tailCache.save();
        }
    });

    const tailMs = performance.now() - tailStarted;
    const joinStarted = performance.now();
    const joins = await prof.measureAsync("journals", async () => {
        const pins = hostPins ?? (await readPins());
        const accounts = new Map<string, string | null>();
        const hosts = new Map<string, PinHost>();

        for (const [sessionId, pin] of pins) {
            accounts.set(sessionId.toLowerCase(), pin.account ?? null);

            if (pin.host) {
                hosts.set(sessionId.toLowerCase(), pin.host);
            }
        }

        const cmux = new Map<string, SessionCmuxLocation>();

        for (const [sessionId, entry] of loadAllSessionCmuxRefs()) {
            // buildRow looks this up with sessionId.toLowerCase(); storing the raw
            // journal id meant any uppercase character silently dropped the cmux
            // location while the account join still resolved.
            cmux.set(sessionId.toLowerCase(), {
                workspaceId: entry.workspaceId ?? null,
                workspaceRef: entry.workspaceRef ?? null,
                paneRef: entry.paneRef ?? null,
                surfaceId: entry.surfaceId ?? null,
                surfaceRef: entry.surfaceRef ?? null,
                windowRef: entry.windowRef ?? null,
                at: entry.at ?? 0,
            });
        }

        return { accounts, hosts, cmux, live: (opts.liveSessionIds ?? liveClaudeSessionIds)() };
    });
    const joinMs = performance.now() - joinStarted;
    const rank: Record<CacheStatus, number> = { HOT: 0, COOLING: 1, CRITICAL: 2, COLD: 3 };
    const rows = records
        .map((r, i) => buildRow(r, usages[i], now, joins))
        .sort(
            (a, b) =>
                rank[a.cacheStatus] - rank[b.cacheStatus] ||
                b.lastCacheAt - a.lastCacheAt ||
                // Deterministic tie-break so equal-clock rows never shuffle between polls.
                a.sessionId.localeCompare(b.sessionId)
        );

    return {
        rows,
        timings: {
            listingMs,
            tailMs,
            joinMs,
            totalMs: performance.now() - started,
            records: records.length,
        },
    };
}

/** Same row math as the usage TUI Sessions tab. */
export async function listSessionRows(opts: ListSessionRowsOptions = {}): Promise<SessionRow[]> {
    return (await listSessionRowsWithTimings(opts)).rows;
}
