import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid, processStartMs, readProcessCommand, START_MS_TOLERANCE } from "@genesiscz/utils/process-identity";

/**
 * Pidfiles that survive pid recycling.
 *
 * The OS reuses pid numbers, so a file holding a bare number cannot answer the
 * only question anyone ever asks of it — "is the process that wrote this still
 * running?". `kill(pid, 0)` succeeds just as happily for whatever unrelated
 * program the kernel handed that number to next.
 *
 * That gap has cost three incidents here:
 *   2026-08-11  ai-proxy's recorded pid landed on `darwinkit serve`. `status`
 *               reported a week-dead proxy as running, and `down` would have
 *               SIGKILLed the innocent process.
 *   2026-08-19  the scheduler daemon's pidfile still held 891 from a daemon
 *               that died without cleanup. macOS had since handed 891 to
 *               WiFiCloudAssetsXPCService, so every launchd respawn read
 *               "already running" and exited — 4284 restarts across 12 hours,
 *               during which nothing refreshed the Claude usage cache.
 *
 * The cure is two-sided, which is why it belongs in one module rather than in
 * each caller: {@link writePidFile} records the owner's command line next to
 * the number, and {@link inspectPidFile} hands back a verdict instead of a
 * bare pid. There is deliberately no `readPid(): number` — a caller that
 * cannot see a status cannot make this mistake again.
 *
 * Picking a reader:
 *   - "should I refuse to start a second copy?" → {@link readLivePid}
 *   - "may I send this pid a signal?"           → {@link readSignalablePid}
 * They differ on `unverified` (identity unknowable), and that difference is
 * the whole point — see each function's note.
 */

export interface PidRecord {
    pid: number;
    /** Command line as of the write. `null` when the OS would not name it (Windows, or `ps` unavailable). */
    command: string | null;
    /**
     * When the owning PROCESS started, epoch ms, or null if unreadable.
     *
     * The command line alone cannot separate "our daemon" from "a second copy
     * launched with identical argv onto the recycled pid". The start time can.
     */
    startedAt: number | null;
    /** Epoch ms of the write. Diagnostics only — never an input to the liveness verdict. */
    writtenAt: number;
}

/** Identity predicate for legacy records, matching `classifyPid`'s `expected`. */
export type PidExpectation = string | ((command: string) => boolean);

export type PidFileState =
    /** No pidfile, or its contents were unreadable. */
    | { status: "none" }
    /** Alive, and confirmed to be the process that wrote the file. */
    | { status: "live"; pid: number; record: PidRecord }
    /** The recorded process is gone. */
    | { status: "dead"; pid: number; record: PidRecord }
    /** Alive, but the pid now belongs to another program — the record is stale. */
    | { status: "foreign"; pid: number; record: PidRecord; command: string }
    /** Alive, and the OS would not tell us what it is. Identity is unknown, not confirmed. */
    | { status: "unverified"; pid: number; record: PidRecord };

interface ReadOpts {
    /**
     * Identity to test legacy bare-number pidfiles against, since those carry
     * none of their own. Ignored once the owner has rewritten the file in the
     * record format, whose captured command line is always the stronger signal.
     */
    expected?: PidExpectation;
}

function parseRecord(raw: string, path: string): PidRecord | null {
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
        return null;
    }

    // Legacy shape A: a bare pid, written before identity capture existed.
    // Still readable, but unverifiable on its own — a caller-supplied
    // `expected` is the only identity signal until the owner rewrites the file.
    if (/^\d+$/.test(trimmed)) {
        return { pid: Number(trimmed), command: null, startedAt: null, writtenAt: 0 };
    }

    // Legacy shape B: `<pid>\n<command line>`, the two-line format DashboardApp
    // introduced when it solved this problem for itself. Readable on sight, so
    // it stays supported rather than orphaning every running dashboard's file.
    const [head, ...rest] = trimmed.split("\n");

    if (head !== undefined && /^\d+$/.test(head.trim()) && rest.length > 0) {
        const command = rest.join("\n").trim();
        return {
            pid: Number(head.trim()),
            command: command.length > 0 ? command : null,
            startedAt: null,
            writtenAt: 0,
        };
    }

    try {
        const parsed = SafeJSON.parse(trimmed) as Partial<PidRecord> | null;

        if (!parsed || typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) {
            logger.debug({ path }, "[pidfile] record has no usable pid");
            return null;
        }

        return {
            pid: parsed.pid,
            command: typeof parsed.command === "string" ? parsed.command : null,
            startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
            writtenAt: typeof parsed.writtenAt === "number" ? parsed.writtenAt : 0,
        };
    } catch (err) {
        logger.debug({ err, path }, "[pidfile] could not parse record");
        return null;
    }
}

/**
 * Parse record content a caller already read. For callers that must own their
 * own read (a lock protocol comparing the exact bytes it validated), where
 * re-reading the file would open a TOCTOU window.
 */
export function parsePidRecord(raw: string): PidRecord | null {
    return parseRecord(raw, "(caller-supplied)");
}

/** Read the raw record without judging liveness. Prefer {@link inspectPidFile}. */
export function readPidRecord(path: string): PidRecord | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        return parseRecord(readFileSync(path, "utf-8"), path);
    } catch (err) {
        logger.debug({ err, path }, "[pidfile] could not read file");
        return null;
    }
}

/** Capture a pid together with the identity that makes it verifiable later. */
export function buildPidRecord(pid: number = process.pid): PidRecord {
    return { pid, command: readProcessCommand(pid), startedAt: processStartMs(pid), writtenAt: Date.now() };
}

/** The on-disk form of a record. Paired with {@link buildPidRecord} for callers that own their write. */
export function serializePidRecord(record: PidRecord): string {
    return `${SafeJSON.stringify(record, null, 2)}\n`;
}

/**
 * Write a pidfile that records who wrote it.
 *
 * `exclusive` uses an atomic `wx` create, so a caller racing for ownership
 * gets EEXIST rather than clobbering a live owner's claim.
 *
 * This writes synchronously. A caller whose write participates in a
 * concurrency race should compose {@link buildPidRecord} with
 * {@link serializePidRecord} and its own async write instead — Bun's sync fs
 * calls have been observed reentering under concurrent async load, which
 * breaks single-winner guarantees (see `src/daemon/daemon.ts`).
 */
export function writePidFile(path: string, opts: { pid?: number; exclusive?: boolean } = {}): PidRecord {
    const record = buildPidRecord(opts.pid);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializePidRecord(record), opts.exclusive ? { flag: "wx" } : {});

    return record;
}

/**
 * Classify a pidfile. Read-only by contract: this is the diagnostic, and it
 * repairs nothing — callers decide what to do with a `foreign` or `dead`
 * verdict themselves.
 */
export function inspectPidFile(path: string, opts: ReadOpts = {}): PidFileState {
    const record = readPidRecord(path);

    if (record === null) {
        return { status: "none" };
    }

    // The recorded command line is the exact identity of the process that
    // claimed this file, so it outranks any predicate the caller guessed at.
    const expected = record.command ?? opts.expected;
    const identity = classifyPid(record.pid, expected);

    // A matching command line still cannot separate our owner from a second
    // copy launched the same way onto the recycled number. The start time can,
    // so when we recorded one it gets the final say.
    if (identity.status === "live" && record.startedAt !== null) {
        const startedAt = processStartMs(record.pid);

        if (startedAt !== null && Math.abs(startedAt - record.startedAt) > START_MS_TOLERANCE) {
            logger.warn(
                { path, pid: record.pid, recordedStart: record.startedAt, actualStart: startedAt },
                "[pidfile] pid matches the recorded command but started at a different time; treating as recycled"
            );

            return { status: "foreign", pid: record.pid, record, command: identity.command ?? "(unknown)" };
        }
    }

    if (identity.status === "foreign") {
        logger.warn(
            { path, pid: record.pid, recorded: record.command, actual: identity.command },
            "[pidfile] recorded pid was recycled onto another program; treating the pidfile as stale"
        );

        return { status: "foreign", pid: record.pid, record, command: identity.command ?? "(unknown)" };
    }

    return { status: identity.status, pid: record.pid, record };
}

/**
 * The pid when a process we can plausibly claim as ours is running, else null.
 *
 * `unverified` counts as live on purpose. It means the OS would not name the
 * process, and for the usual caller ("should I refuse to start a second
 * copy?") assuming ours is the safe direction: refusing to start is
 * recoverable, running two owners of the same state is not.
 *
 * 🛑 Never signal what this returns — use {@link readSignalablePid}.
 */
export function readLivePid(path: string, opts: ReadOpts = {}): number | null {
    const state = inspectPidFile(path, opts);

    return state.status === "live" || state.status === "unverified" ? state.pid : null;
}

/**
 * The pid ONLY when its identity is positively confirmed, else null.
 *
 * Use this before sending any signal. An `unverified` pid may belong to a
 * stranger, and the 2026-08-11 incident would have SIGKILLed one — so here the
 * safe direction inverts: refuse to signal what we cannot identify.
 */
export function readSignalablePid(path: string, opts: ReadOpts = {}): number | null {
    const state = inspectPidFile(path, opts);

    return state.status === "live" ? state.pid : null;
}

/** True when the pidfile still names this process — the per-tick ownership check. */
export function ownsPidFile(path: string): boolean {
    return readPidRecord(path)?.pid === process.pid;
}

/**
 * Remove the pidfile. Guarded by default: a process that lost its claim must
 * not delete the new owner's file on its way out.
 */
export function clearPidFile(path: string, opts: { force?: boolean } = {}): boolean {
    if (!existsSync(path)) {
        return false;
    }

    if (!opts.force && !ownsPidFile(path)) {
        logger.debug({ path }, "[pidfile] not clearing a pidfile owned by someone else");
        return false;
    }

    try {
        unlinkSync(path);
        return true;
    } catch (err) {
        logger.debug({ err, path }, "[pidfile] could not remove file");
        return false;
    }
}

function errnoCode(err: unknown): string | undefined {
    return err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
}

/**
 * Atomically steal a pidfile whose content the caller pre-validated as STALE.
 *
 * Rename into a unique temp name, verify the stolen bytes are exactly the
 * validated artifact (a mismatch means a fresh owner claimed between check and
 * rename — restore it best-effort and lose), then either `wx`-create our own
 * record (`claim: true`, the default) or leave the slot empty (`claim: false`,
 * a race-safe DELETE for cleanup paths). Returns true only for the single
 * racer that stole the validated artifact.
 *
 * Async on purpose: Bun's synchronous fs calls reenter under concurrent
 * async-driven load (many concurrent `renameSync` callers can each observe a
 * "successful" rename of one source — verified empirically in the daemon),
 * which breaks the single-winner guarantee this function exists to provide.
 * The sync `writePidFile({ exclusive })` above is therefore NOT a race
 * primitive; racing callers belong here.
 */
export async function attemptStaleTakeover(
    path: string,
    expectedContent: string,
    opts: { claim?: boolean } = {}
): Promise<boolean> {
    const tempPath = `${path}.stale-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

    try {
        await rename(path, tempPath);
    } catch (err) {
        if (errnoCode(err) === "ENOENT") {
            return false;
        }

        throw err;
    }

    let stolen: string | null = null;
    try {
        stolen = await readFile(tempPath, "utf-8");
    } catch (err) {
        logger.debug({ err, tempPath }, "[pidfile] stolen file unreadable");
    }

    if (stolen === null || stolen.trim() !== expectedContent.trim()) {
        // We grabbed something other than the validated-stale file — a fresh
        // owner wrote between the caller's check and our rename. Put it back
        // and lose; if the slot was re-claimed meanwhile, the robbed owner's
        // own liveness checks are the backstop.
        if (stolen !== null) {
            try {
                await writeFile(path, stolen, { flag: "wx" });
            } catch (err) {
                logger.debug({ err, path }, "[pidfile] stale-takeover restore skipped (slot re-claimed)");
            }
        }

        try {
            unlinkSync(tempPath);
        } catch (err) {
            logger.debug({ err, tempPath }, "[pidfile] takeover temp cleanup failed");
        }

        return false;
    }

    if (opts.claim !== false) {
        try {
            await writeFile(path, serializePidRecord(buildPidRecord()), { flag: "wx" });
        } catch (err) {
            if (errnoCode(err) === "EEXIST") {
                return false;
            }

            throw err;
        } finally {
            try {
                unlinkSync(tempPath);
            } catch (err) {
                logger.debug({ err, tempPath }, "[pidfile] takeover temp cleanup failed");
            }
        }

        return true;
    }

    try {
        unlinkSync(tempPath);
    } catch (err) {
        logger.debug({ err, tempPath }, "[pidfile] takeover temp cleanup failed");
    }

    return true;
}
