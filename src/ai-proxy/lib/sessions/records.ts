/**
 * Session records: one file per `tools claude codex` session, the key it presents, and the accounts it may use.
 *
 * `~/.genesis-tools/ai-proxy/sessions/<id>.json` (file 0600, folder 0700, atomic writes). `<id>` IS Claude Code's
 * session id: the launcher generates it and passes `claude --session-id <id>`, and Claude Code keeps it across
 * `--resume`, so the record, `tags.session`, the ai-proxy transcript file and the upstream cache key all carry the
 * one id Claude Code writes its own transcript under. The record stores only a SHA-256 of the session key.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { PromptCacheKeyPolicy } from "@genesiscz/utils/ai/prompt-cache-key";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isArbitrationBusy, withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { processStartMs, START_MS_TOLERANCE } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync, isJsonObject } from "@genesiscz/utils/storage/atomic-file";

export const SESSION_KEY_PREFIX = "gts_";
export const SESSION_RECORD_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;

export function isCompactionId(id: string): boolean {
    return /^gtc1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}
/** Closed records stay for stats this long unless `sessionRetentionDays` says otherwise. */
export const DEFAULT_SESSION_RETENTION_DAYS = 30;

/** Which upstream route a manual switch moved. */
export type SessionAgent = "codex" | "claude" | "grok";

export interface SessionMove {
    agent: SessionAgent;
    from: string;
    to: string;
    at: string;
}

/** A metered account the user confirmed for this session (`--allow-metered <account>` or the y/N prompt). */
export interface MeteredConfirmation {
    account: string;
    confirmedAt: string;
    how: "flag" | "prompt";
}

export type SessionCloseReason = "exited" | "process-gone" | "pid-recycled";

export interface AiProxySessionRecord {
    version: 1;
    /** Claude Code's session id; the file name. */
    id: string;
    /** SHA-256 (hex) of the `gts_` key; the key itself is never stored. */
    keyHash: string;
    createdAt: string;
    lastSeenAt?: string;
    closedAt?: string;
    closeReason?: SessionCloseReason;
    launcherPid?: number;
    claudePid?: number;
    claudePidStartMs?: number;
    cwd?: string;
    /** `--fork-session`: Claude Code picks a new id, so the first request names it (stored in `claudeSessionId`). */
    forkPending?: boolean;
    /** The session id Claude Code sent in `metadata.user_id`, when it is not the record id (fork). */
    claudeSessionId?: string;
    codexProxyAccount?: string;
    codexAccount?: string;
    claudeProxyAccount?: string;
    claudeAccount?: string;
    grokProxyAccount?: string;
    grokAccount?: string;
    model?: string;
    effort?: string;
    window?: number;
    /** Effective launch context limit for picker filtering; absent when custom settings make it unknown. */
    pickerContextTokens?: number;
    compactPercent?: number;
    cacheKeyPolicy?: PromptCacheKeyPolicy;
    /** The subagents the launcher defined with their own model (`--agents`); an Agent call's `model` cannot override them. */
    agents?: string[];
    moves: SessionMove[];
    meteredConfirmed: MeteredConfirmation[];
    /** Exact compaction IDs this session encountered without a recoverable summary. */
    blockedCompactions?: string[];
    /** Explicitly acknowledged loss of context, scoped to this session and marker. */
    droppedCompactions?: string[];
}

export type NewSessionRecord = Omit<
    AiProxySessionRecord,
    "version" | "keyHash" | "createdAt" | "moves" | "meteredConfirmed"
> &
    Partial<Pick<AiProxySessionRecord, "moves" | "meteredConfirmed">>;

/** The session id every request of this session is tagged with: the forked id once known, else the record id. */
export function sessionTagId(record: AiProxySessionRecord): string {
    return record.claudeSessionId ?? record.id;
}

/** The record field that names each agent's configured proxy account. */
export const SESSION_ACCOUNT_FIELD = {
    codex: "codexProxyAccount",
    claude: "claudeProxyAccount",
    grok: "grokProxyAccount",
} as const satisfies Record<SessionAgent, keyof AiProxySessionRecord>;

/** The record field that names each agent's login (a `tools codex` / `tools claude` / `tools grok` account). */
export const SESSION_LOGIN_FIELD = {
    codex: "codexAccount",
    claude: "claudeAccount",
    grok: "grokAccount",
} as const satisfies Record<SessionAgent, keyof AiProxySessionRecord>;

/** The name of the account the proxy builds in memory for a login (❓ DECISION 1 a): never written to the config. */
export function loginAccountName(login: string): string {
    return `login:${login}`;
}

/**
 * The account a session uses for an agent: the configured proxy account the record names (the legacy Codex account
 * that reads ~/.codex/auth.json among them), else the in-memory account of the record's login.
 */
export function sessionAccountName(record: AiProxySessionRecord, agent: SessionAgent): string | undefined {
    const proxy = record[SESSION_ACCOUNT_FIELD[agent]];

    if (proxy) {
        return proxy;
    }

    const login = record[SESSION_LOGIN_FIELD[agent]];
    return login ? loginAccountName(login) : undefined;
}

/** Accounts this session may route to. */
export function sessionProxyAccounts(record: AiProxySessionRecord): string[] {
    return (Object.keys(SESSION_ACCOUNT_FIELD) as SessionAgent[])
        .map((agent) => sessionAccountName(record, agent))
        .filter((name): name is string => typeof name === "string" && name.length > 0);
}

export function sessionsDir(): string {
    return join(getAiProxyStorage().getBaseDir(), "sessions");
}

/** Ids become file names: a Claude Code UUID, or anything else made of safe characters. */
function assertSafeId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
        throw new Error(`invalid session id "${id}"`);
    }
}

function recordPath(id: string): string {
    assertSafeId(id);
    return join(sessionsDir(), `${id}.json`);
}

export function isSessionKey(token: string | null | undefined): token is string {
    return typeof token === "string" && token.startsWith(SESSION_KEY_PREFIX);
}

export function newSessionKey(): string {
    return `${SESSION_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashSessionKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}

function isSessionRecord(value: unknown): value is AiProxySessionRecord {
    return (
        isJsonObject(value) &&
        value.version === 1 &&
        typeof value.id === "string" &&
        typeof value.keyHash === "string" &&
        typeof value.createdAt === "string" &&
        Array.isArray(value.moves) &&
        Array.isArray(value.meteredConfirmed) &&
        (value.blockedCompactions === undefined ||
            (Array.isArray(value.blockedCompactions) &&
                value.blockedCompactions.every((id) => typeof id === "string" && isCompactionId(id)))) &&
        (value.droppedCompactions === undefined ||
            (Array.isArray(value.droppedCompactions) &&
                value.droppedCompactions.every((id) => typeof id === "string" && isCompactionId(id))))
    );
}

function ensureSessionsDir(): string {
    const dir = sessionsDir();

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: SESSION_DIR_MODE });
    }

    // mkdir's mode is masked by the umask, and an older folder may be wider: set it outright.
    chmodSync(dir, SESSION_DIR_MODE);
    return dir;
}

export function writeSessionRecord(record: AiProxySessionRecord): void {
    ensureSessionsDir();
    atomicWriteFileSync(recordPath(record.id), `${SafeJSON.stringify(record, null, 2)}\n`, {
        mode: SESSION_RECORD_FILE_MODE,
    });
}

export function readSessionRecord(id: string): AiProxySessionRecord | undefined {
    const path = recordPath(id);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        if (isSessionRecord(parsed)) {
            return parsed;
        }

        logger.warn({ path }, "ai-proxy: session record has an unknown shape, ignored");
    } catch (err) {
        logger.warn({ path, err }, "ai-proxy: session record is unreadable, ignored");
    }

    return undefined;
}

export function listSessionRecords(): AiProxySessionRecord[] {
    const dir = sessionsDir();

    if (!existsSync(dir)) {
        return [];
    }

    const records: AiProxySessionRecord[] = [];

    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) {
            continue;
        }

        const record = readSessionRecord(name.slice(0, -".json".length));

        if (record) {
            records.push(record);
        }
    }

    return records;
}

/** Make a record and its key. The key is returned once and never stored. */
export function createSessionRecord(input: NewSessionRecord): { record: AiProxySessionRecord; key: string } {
    if (readSessionRecord(input.id)) {
        throw new Error(`session ${input.id} already has a record`);
    }

    const key = newSessionKey();
    const record: AiProxySessionRecord = {
        ...input,
        version: 1,
        keyHash: hashSessionKey(key),
        createdAt: new Date().toISOString(),
        moves: input.moves ?? [],
        meteredConfirmed: input.meteredConfirmed ?? [],
    };

    writeSessionRecord(record);
    sessionKeyIndex.remember(record);
    return { record, key };
}

/**
 * A launch's record: a new one, or, on `--resume` (Claude Code keeps the session id), the same record reopened with a
 * fresh key and this launch's accounts and settings. The old key stops working. The record is rebuilt from this
 * launch: a field the launch leaves out (a proxy account replaced by a login, a Claude account turned off with
 * `--claude none`) is gone, never carried over. Only the history stays: `createdAt`, `lastSeenAt`, `moves` and earlier
 * metered confirmations.
 */
export function openSessionRecord(input: NewSessionRecord): {
    record: AiProxySessionRecord;
    key: string;
    reopened: boolean;
} {
    return withRecordLock(input.id, () => {
        const existing = readSessionRecord(input.id);

        if (!existing) {
            return { ...createSessionRecord(input), reopened: false };
        }

        const key = newSessionKey();
        const confirmed = [...existing.meteredConfirmed, ...(input.meteredConfirmed ?? [])];
        const record: AiProxySessionRecord = {
            ...input,
            version: 1,
            keyHash: hashSessionKey(key),
            createdAt: existing.createdAt,
            ...(existing.lastSeenAt ? { lastSeenAt: existing.lastSeenAt } : {}),
            moves: existing.moves,
            meteredConfirmed: confirmed.filter(
                (entry, index) => confirmed.findIndex((other) => other.account === entry.account) === index
            ),
        };

        writeSessionRecord(record);
        sessionKeyIndex.remember(record);
        return { record, key, reopened: true };
    });
}

/**
 * Runs one read-change-write of a record under that record's lock. The proxy (lastSeenAt), `session use` (routes,
 * moves) and the launcher (pid, close) write the same file from three processes; without the lock a stale read
 * written back undid the other's change. One attempt: a held lock throws (`isSessionRecordBusy`), because a sync wait
 * would freeze the proxy's event loop. A CLI caller retries with `whenSessionRecordFree`.
 */
function withRecordLock<T>(id: string, fn: () => T): T {
    ensureSessionsDir();
    return withPathArbitrationSync(recordPath(id), fn);
}

/** True for the error a record lock held by another writer throws. */
export function isSessionRecordBusy(error: unknown): boolean {
    return isArbitrationBusy(error);
}

/** Retries a record write while another process holds the record's lock, up to `waitMs`. */
export async function whenSessionRecordFree<T>(write: () => T, waitMs = 2_000): Promise<T> {
    const deadline = Date.now() + waitMs;

    for (;;) {
        try {
            return write();
        } catch (error) {
            const remaining = deadline - Date.now();

            if (!isSessionRecordBusy(error) || remaining <= 0) {
                throw error;
            }

            await Bun.sleep(Math.min(25, remaining));
        }
    }
}

/** Read, change and write under the record lock; a supplied key hash also guards launch ownership. */
export function updateSessionRecord({
    id,
    change,
    expectedKeyHash,
}: {
    id: string;
    change: (record: AiProxySessionRecord) => void;
    expectedKeyHash?: string;
}): AiProxySessionRecord | undefined {
    return withRecordLock(id, () => {
        const record = readSessionRecord(id);

        if (!record || (expectedKeyHash !== undefined && record.keyHash !== expectedKeyHash)) {
            return undefined;
        }

        change(record);
        writeSessionRecord(record);
        return record;
    });
}

export async function noteBlockedCompaction(
    sessionId: string,
    marker: string
): Promise<AiProxySessionRecord | undefined> {
    if (!isCompactionId(marker)) {
        throw new Error("Invalid compaction ID");
    }

    return whenSessionRecordFree(() =>
        updateSessionRecord({
            id: sessionId,
            change: (record) => {
                record.blockedCompactions ??= [];

                if (!record.blockedCompactions.includes(marker)) {
                    record.blockedCompactions.push(marker);
                }
            },
        })
    );
}

export async function acknowledgeCompactionDrop({
    sessionId,
    marker,
    acknowledged,
}: {
    sessionId: string;
    marker: string;
    acknowledged: boolean;
}): Promise<AiProxySessionRecord | undefined> {
    if (!acknowledged || !isCompactionId(marker)) {
        throw new Error("A valid compaction ID and explicit context-loss acknowledgement are required");
    }

    return whenSessionRecordFree(() =>
        updateSessionRecord({
            id: sessionId,
            change: (record) => {
                if (!record.blockedCompactions?.includes(marker)) {
                    throw new Error("This session has not reported that compaction ID as blocked");
                }

                record.droppedCompactions ??= [];

                if (!record.droppedCompactions.includes(marker)) {
                    record.droppedCompactions.push(marker);
                }
            },
        })
    );
}

export function closeSessionRecord({
    id,
    reason = "exited",
    expectedKeyHash,
}: {
    id: string;
    reason?: SessionCloseReason;
    expectedKeyHash?: string;
}): AiProxySessionRecord | undefined {
    return updateSessionRecord({
        id,
        expectedKeyHash,
        change: (record) => {
            if (!record.closedAt) {
                record.closedAt = new Date().toISOString();
                record.closeReason = reason;
            }
        },
    });
}

/**
 * Key hash → record id, so a request costs one map lookup and one small file read (the file, not the map, says
 * whether the session is still open). A key the map does not know triggers a rescan of the folder, because the
 * launcher writes a new record from another process, but only when the folder changed since the last scan: every
 * record write is an atomic rename into it, so its mtime moves. Without that gate any request with a made-up `gts_`
 * key parsed every record, synchronously, before authentication.
 */
class SessionKeyIndex {
    private byHash = new Map<string, string>();
    private scannedDir: string | undefined;
    private scannedMtimeMs: number | undefined;
    scans = 0;

    remember(record: AiProxySessionRecord): void {
        this.byHash.set(record.keyHash, record.id);
    }

    private dirMtimeMs(): number | undefined {
        try {
            return statSync(sessionsDir()).mtimeMs;
        } catch {
            return undefined;
        }
    }

    private rescan(): void {
        this.scans++;
        this.byHash.clear();
        this.scannedDir = sessionsDir();
        // Read before listing, so a record written during the scan moves the mtime past this value.
        this.scannedMtimeMs = this.dirMtimeMs();

        for (const record of listSessionRecords()) {
            this.byHash.set(record.keyHash, record.id);
        }
    }

    resolve(key: string): AiProxySessionRecord | undefined {
        const hash = hashSessionKey(key);

        if (this.scannedDir !== sessionsDir()) {
            this.rescan();
        }

        let id = this.byHash.get(hash);

        if (!id && this.dirMtimeMs() !== this.scannedMtimeMs) {
            this.rescan();
            id = this.byHash.get(hash);
        }

        const record = id ? readSessionRecord(id) : undefined;
        return record?.keyHash === hash ? record : undefined;
    }

    reset(): void {
        this.byHash.clear();
        this.scannedDir = undefined;
        this.scannedMtimeMs = undefined;
        this.scans = 0;
    }
}

const sessionKeyIndex = new SessionKeyIndex();

export type SessionKeyResolution =
    | { state: "open"; record: AiProxySessionRecord }
    | { state: "unknown" }
    | { state: "closed"; record: AiProxySessionRecord };

export function resolveSessionKey(key: string): SessionKeyResolution {
    const record = sessionKeyIndex.resolve(key);

    if (!record) {
        return { state: "unknown" };
    }

    return record.closedAt ? { state: "closed", record } : { state: "open", record };
}

export function _resetSessionKeyIndexForTest(): void {
    sessionKeyIndex.reset();
}

export function _sessionKeyIndexScansForTest(): number {
    return sessionKeyIndex.scans;
}

export interface ProcessProbe {
    alive: (pid: number) => boolean;
    startMs: (pid: number) => number | null;
}

const realProcessProbe: ProcessProbe = { alive: isProcessAlive, startMs: processStartMs };

export interface SessionSweepResult {
    closed: Array<{ id: string; reason: SessionCloseReason }>;
    pruned: string[];
}

/**
 * Close open records whose Claude process is gone (or whose pid now belongs to a newer process), and delete closed
 * records older than the retention. A launcher that exits normally closes its own record; this catches a crash.
 */
export function sweepSessionRecords(
    options: { retentionDays?: number; now?: number; probe?: ProcessProbe } = {}
): SessionSweepResult {
    const now = options.now ?? Date.now();
    const probe = options.probe ?? realProcessProbe;
    const retentionMs = (options.retentionDays ?? DEFAULT_SESSION_RETENTION_DAYS) * 86_400_000;
    const result: SessionSweepResult = { closed: [], pruned: [] };

    for (const record of listSessionRecords()) {
        if (record.closedAt) {
            if (now - Date.parse(record.closedAt) > retentionMs) {
                try {
                    withRecordLock(record.id, () => {
                        const current = readSessionRecord(record.id);

                        if (
                            current?.keyHash === record.keyHash &&
                            current.closedAt &&
                            now - Date.parse(current.closedAt) > retentionMs
                        ) {
                            unlinkSync(recordPath(record.id));
                            result.pruned.push(record.id);
                        }
                    });
                } catch (error) {
                    if (!isSessionRecordBusy(error)) {
                        throw error;
                    }

                    logger.debug({ session: record.id }, "ai-proxy: session record busy, the next sweep prunes it");
                }
            }

            continue;
        }

        const pid = record.claudePid ?? record.launcherPid;

        if (pid === undefined) {
            continue;
        }

        let reason: SessionCloseReason | undefined;

        if (!probe.alive(pid)) {
            reason = "process-gone";
        } else if (record.claudePid !== undefined && record.claudePidStartMs !== undefined) {
            const startMs = probe.startMs(record.claudePid);

            if (startMs !== null && Math.abs(startMs - record.claudePidStartMs) > START_MS_TOLERANCE) {
                reason = "pid-recycled";
            }
        }

        if (reason) {
            try {
                if (closeSessionRecord({ id: record.id, reason, expectedKeyHash: record.keyHash })) {
                    result.closed.push({ id: record.id, reason });
                }
            } catch (error) {
                if (!isSessionRecordBusy(error)) {
                    throw error;
                }

                logger.debug({ session: record.id }, "ai-proxy: session record busy, the next sweep closes it");
            }
        }
    }

    if (result.closed.length > 0 || result.pruned.length > 0) {
        logger.info(
            { closed: result.closed, pruned: result.pruned.length, dir: sessionsDir() },
            "ai-proxy: session sweep"
        );
    }

    return result;
}

/** lastSeenAt is written at most this often, so a busy session does not rewrite its record on every request. */
const LAST_SEEN_WRITE_MS = 60_000;
const warnedMismatches = new Set<string>();

/**
 * Called for every request of a session with the session id Claude Code put in `metadata.user_id`. A fork names
 * its id here once; any other difference is logged (once per pair) and never re-keys the session. Returns the
 * record the request should be tagged with.
 */
export function noteSessionRequest(
    record: AiProxySessionRecord,
    claudeSessionId: string | undefined,
    now = Date.now()
): AiProxySessionRecord {
    if (record.forkPending && !record.claudeSessionId && claudeSessionId) {
        return (
            updateUnlessBusy(record.id, (current) => {
                current.claudeSessionId = claudeSessionId;
                current.forkPending = false;
                current.lastSeenAt = new Date(now).toISOString();
            }) ?? record
        );
    }

    if (claudeSessionId && claudeSessionId !== sessionTagId(record)) {
        const pair = `${record.id}:${claudeSessionId}`;

        if (!warnedMismatches.has(pair)) {
            warnedMismatches.add(pair);
            logger.warn(
                { session: record.id, expected: sessionTagId(record), claudeSessionId },
                "ai-proxy: a session key's request carries another Claude Code session id; tagged with the record's"
            );
        }
    }

    const lastSeen = record.lastSeenAt ? Date.parse(record.lastSeenAt) : 0;

    if (now - lastSeen >= LAST_SEEN_WRITE_MS) {
        return (
            updateUnlessBusy(record.id, (current) => {
                current.lastSeenAt = new Date(now).toISOString();
            }) ?? record
        );
    }

    return record;
}

/**
 * A request's write to its record: skipped while another process holds the record's lock. Both writes it makes
 * (lastSeenAt, the fork's id) are retried by the session's next request, so waiting in the proxy buys nothing.
 */
function updateUnlessBusy(
    id: string,
    change: (record: AiProxySessionRecord) => void
): AiProxySessionRecord | undefined {
    try {
        return updateSessionRecord({ id, change });
    } catch (error) {
        if (!isSessionRecordBusy(error)) {
            throw error;
        }

        logger.debug({ session: id }, "ai-proxy: session record busy, this request's write is skipped");
        return undefined;
    }
}
