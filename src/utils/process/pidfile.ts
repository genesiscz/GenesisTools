import {
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isArbitrationBusy, withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import {
    classifyPid,
    type PidIdentity,
    processStartMs,
    readProcessCommand,
    START_MS_TOLERANCE,
} from "@genesiscz/utils/process-identity";

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

/**
 * One identity verdict for a PidRecord: command line, then start time.
 *
 * Callers that already hold the parsed record (file locks comparing the exact
 * bytes they validated) must not invent a second rule. A live own pid with a
 * matching command and start time is `live`; a recycled number — including this
 * process's — is `foreign`/`dead` and safe to steal.
 */
export function classifyPidRecord(record: PidRecord, expected?: PidExpectation): PidIdentity {
    const identity = classifyPid(record.pid, record.command ?? expected);
    // A record without a command (one taken before a child's exec, or of a process this user cannot read) still
    // carries its start time, and a different start time is a recycled pid.
    if ((identity.status === "live" || identity.status === "unverified") && record.startedAt !== null) {
        const startedAt = processStartMs(record.pid);
        if (startedAt !== null && Math.abs(startedAt - record.startedAt) > START_MS_TOLERANCE) {
            return {
                status: "foreign",
                pid: record.pid,
                command: (identity.status === "live" ? identity.command : null) ?? "(unknown)",
            };
        }
    }

    return identity;
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
    const command = readProcessCommand(pid);
    // Linux spawns by fork then exec, and until the exec the child shows this process's command line; the kernel read
    // is fast enough to see that. A record naming us would read as foreign once the child execs, so it keeps only the
    // start time, which the exec does not change. macOS starts children with posix_spawn, which has no such window.
    const beforeExec = pid !== process.pid && command !== null && command === readProcessCommand(process.pid);
    return { pid, command: beforeExec ? null : command, startedAt: processStartMs(pid), writtenAt: Date.now() };
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
    return withPathArbitrationSync(path, () => {
        const record = buildPidRecord(opts.pid);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, serializePidRecord(record), opts.exclusive ? { flag: "wx" } : {});
        return record;
    });
}

/**
 * `writePidFile` for an async caller that must not fail on brief arbiter contention: an ELOCKED
 * answer is retried every 25 ms until `waitMs` (default 2 s) runs out, then thrown. EEXIST and
 * every other error pass through at once.
 */
export async function writePidFileWhenFree(
    path: string,
    opts: { pid?: number; exclusive?: boolean; waitMs?: number } = {}
): Promise<PidRecord> {
    const deadline = Date.now() + (opts.waitMs ?? 2_000);
    for (;;) {
        try {
            return writePidFile(path, opts);
        } catch (error) {
            const remaining = deadline - Date.now();
            if (!isArbitrationBusy(error) || remaining <= 0) {
                throw error;
            }

            logger.debug({ path, remaining }, "pidfile arbiter busy; retrying");
            await Bun.sleep(Math.min(25, remaining));
        }
    }
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

    const identity = classifyPidRecord(record, opts.expected);
    if (identity.status === "foreign") {
        logger.warn(
            { path, pid: record.pid, recorded: record.command, actual: identity.command },
            "[pidfile] recorded pid was recycled; treating the pidfile as stale"
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
    try {
        return withPathArbitrationSync(path, () => {
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
        });
    } catch (err) {
        logger.debug({ err, path }, "[pidfile] claim arbitration busy during clear");
        return false;
    }
}

function errnoCode(err: unknown): string | undefined {
    return err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
}

/**
 * How long a holder file that names no process (empty, or bytes that are not a record) counts as an owner between
 * its `wx` create and its write. A `wx` write is an open and then a separate write, so a live owner is empty for a
 * moment; a SIGKILL between the two leaves the file empty for good. Inside the grace the file is held, after it the
 * file is an orphan and taken over. The age is the file's own mtime, so a sync caller decides without sleeping.
 */
export const EMPTY_HOLDER_GRACE_MS = 1_000;

/** What a takeover did: the stale claim is gone (`taken`), its holder keeps it (`held`), or another racer moved first. */
export type ClaimTakeover = "taken" | "held" | "lost-race";

export interface TakeOverStaleClaimInput {
    /**
     * Whether a holder that names a process has lost its claim (dead, recycled pid, or whatever the caller's rule
     * says). Never asked about a holder that names no process: the empty-holder rule above decides that one for
     * every caller. `raw` is the exact content the verdict is about, for a caller that reports more of it.
     */
    holderIsStale: (holder: PidRecord, raw: string) => boolean;
    /** The path whose claim arbiter serializes this decision; the claim path itself unless files share one. */
    arbiter: string;
}

/**
 * Remove a claim file only when it still holds `expectedContent`: rename it to a unique temp name, compare the bytes
 * it held, and on a mismatch (a fresh owner wrote between the caller's check and the rename) put it back with `wx` and
 * lose. True only for the racer that removed the validated content. Call it inside the path's arbiter.
 */
function removeValidatedClaim(path: string, expectedContent: string): boolean {
    const tempPath = `${path}.stale-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

    try {
        renameSync(path, tempPath);
    } catch (err) {
        if (errnoCode(err) === "ENOENT") {
            return false;
        }

        throw err;
    }

    let stolen: string | null = null;
    try {
        stolen = readFileSync(tempPath, "utf-8");
    } catch (err) {
        logger.debug({ err, tempPath }, "[pidfile] stolen file unreadable");
    }

    const matches = stolen !== null && stolen.trim() === expectedContent.trim();

    if (!matches && stolen !== null) {
        // If the slot was re-claimed meanwhile, the robbed owner's own liveness checks are the backstop.
        try {
            writeFileSync(path, stolen, { flag: "wx" });
        } catch (err) {
            logger.debug({ err, path }, "[pidfile] stale-takeover restore skipped (slot re-claimed)");
        }
    }

    try {
        unlinkSync(tempPath);
    } catch (err) {
        // Nothing sweeps this random-suffixed name, so a leak must be on record.
        logger.debug({ err, tempPath }, "[pidfile] takeover temp cleanup failed");
    }

    return matches;
}

/** The holder's bytes and the mtime of the same file, read through one descriptor. Null when the file is gone. */
function readHolder(path: string): { raw: string; mtimeMs: number } | null {
    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (err) {
        if (errnoCode(err) === "ENOENT") {
            return null;
        }

        throw err;
    }

    try {
        return { raw: readFileSync(fd, "utf-8"), mtimeMs: fstatSync(fd).mtimeMs };
    } finally {
        closeSync(fd);
    }
}

function takeOverStaleClaimUnlocked(path: string, input: TakeOverStaleClaimInput): ClaimTakeover {
    let holder: { raw: string; mtimeMs: number } | null;
    try {
        holder = readHolder(path);
    } catch (err) {
        // A holder this process cannot read cannot be judged, and judging it stale could delete a live claim.
        logger.debug({ err, path }, "[pidfile] claim unreadable; leaving it held");
        return "held";
    }

    if (holder === null) {
        return "lost-race";
    }

    const record = parseRecord(holder.raw, path);

    if (record === null) {
        const ageMs = Date.now() - holder.mtimeMs;

        if (Math.abs(ageMs) < EMPTY_HOLDER_GRACE_MS) {
            logger.debug({ path, ageMs }, "[pidfile] claim names no process yet; its owner may be writing");
            return "held";
        }

        logger.debug({ path, ageMs }, "[pidfile] claim names no process past the grace; taking the orphan over");
    } else if (!input.holderIsStale(record, holder.raw)) {
        return "held";
    }

    return removeValidatedClaim(path, holder.raw) ? "taken" : "lost-race";
}

/**
 * The one takeover of a stale claim file. Under the path's arbiter it reads the holder, decides (the empty-holder rule
 * here, `holderIsStale` for a record), and removes the claim only when the removed bytes are the ones it judged. It
 * leaves the slot empty: the caller makes its own `wx` create, so exactly one creator wins after a `taken`.
 *
 * Synchronous on purpose: the read, the verdict and the rename run as one section that no other code of this process
 * can enter, and the arbiter keeps other processes out of it. A busy arbiter is a `lost-race`.
 */
export function takeOverStaleClaim(path: string, input: TakeOverStaleClaimInput): ClaimTakeover {
    const step = takeOverUnderArbiter(path, input);
    return step === "busy" ? "lost-race" : step;
}

function takeOverUnderArbiter(path: string, input: TakeOverStaleClaimInput): ClaimTakeover | "busy" {
    try {
        return withPathArbitrationSync(input.arbiter, () => takeOverStaleClaimUnlocked(path, input));
    } catch (err) {
        if (isArbitrationBusy(err)) {
            return "busy";
        }

        throw err;
    }
}

/**
 * {@link takeOverStaleClaim} for a caller that awaits: a busy arbiter (another racer inside its takeover, which takes
 * well under a millisecond) is tried again every 25 ms until `waitMs` (default 250 ms) runs out, then `lost-race`.
 */
export async function takeOverStaleClaimAsync(
    path: string,
    input: TakeOverStaleClaimInput & { waitMs?: number }
): Promise<ClaimTakeover> {
    const deadline = Date.now() + (input.waitMs ?? 250);

    for (;;) {
        const step = takeOverUnderArbiter(path, input);
        const remaining = deadline - Date.now();

        if (step !== "busy") {
            return step;
        }

        if (remaining <= 0) {
            return "lost-race";
        }

        await Bun.sleep(Math.min(25, remaining));
    }
}

/**
 * Remove (or, with `claim: true`, the default, replace with this process's record) a claim whose content the caller
 * already validated as stale. True only for the single racer that removed exactly that content. For a caller that
 * judges the holder itself (chrome-devtools cleanup); a claim that needs a verdict goes through
 * {@link takeOverStaleClaim}.
 */
export async function attemptStaleTakeover(
    path: string,
    expectedContent: string,
    opts: { claim?: boolean } = {}
): Promise<boolean> {
    let removed: boolean;
    try {
        removed = withPathArbitrationSync(path, () => removeValidatedClaim(path, expectedContent));
    } catch (err) {
        if (isArbitrationBusy(err)) {
            return false;
        }

        throw err;
    }

    if (!removed || opts.claim === false) {
        return removed;
    }

    try {
        await createPidFile(path);
        return true;
    } catch (err) {
        if (errnoCode(err) === "EEXIST") {
            return false;
        }

        throw err;
    }
}

/** How a claim went: ours (`tookOver` when it replaced a stale claim), kept by its owner, or lost to a racer. */
export type PidClaim =
    | { status: "claimed"; tookOver: boolean }
    | { status: "held"; state: PidFileState }
    | { status: "lost" };

/** A holder that names a process. A holder that names none is never a caller's call (see EMPTY_HOLDER_GRACE_MS). */
export type PidHolderState = Exclude<PidFileState, { status: "none" }>;

export interface ClaimPidFileOptions {
    /** The owner's command for a record that names none (a legacy bare-number file). */
    expected?: PidExpectation;
    /**
     * Which holders may be taken over. Default: all but a live (or unverified) other process, so a dead owner, a
     * recycled pid and a record of this process (a spawner's pre-write) are taken over. An empty or unreadable file
     * is not asked about: it is held inside {@link EMPTY_HOLDER_GRACE_MS} and taken over after it, for every caller.
     */
    reclaimable?: (state: PidHolderState) => boolean;
    /** Takeover rounds before the claim is lost (default 3). */
    attempts?: number;
    /** The pause after a lost round (default none). */
    retryMs?: number;
}

/** The `wx` create of this process's record; its folder is made only when it is missing. */
async function createPidFile(path: string): Promise<void> {
    const content = serializePidRecord(buildPidRecord());

    try {
        await writeFile(path, content, { flag: "wx" });
    } catch (err) {
        if (errnoCode(err) !== "ENOENT") {
            throw err;
        }

        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, { flag: "wx" });
    }
}

function reclaimableByDefault(state: PidHolderState): boolean {
    return !((state.status === "live" || state.status === "unverified") && state.pid !== process.pid);
}

function holderState(record: PidRecord, expected: PidExpectation | undefined): PidHolderState {
    const identity = classifyPidRecord(record, expected);
    return identity.status === "foreign"
        ? { status: "foreign", pid: record.pid, record, command: identity.command ?? "(unknown)" }
        : { status: identity.status, pid: record.pid, record };
}

/**
 * Claim a pidfile as this process's: an atomic `wx` create, and when the file exists, {@link takeOverStaleClaimAsync}
 * with the caller's `reclaimable` rule, then the `wx` create again. Only EEXIST enters the takeover; any other write
 * error is thrown.
 */
export async function claimPidFile(path: string, opts: ClaimPidFileOptions = {}): Promise<PidClaim> {
    const reclaimable = opts.reclaimable ?? reclaimableByDefault;

    for (let attempt = 1; attempt <= (opts.attempts ?? 3); attempt++) {
        try {
            await createPidFile(path);
            return { status: "claimed", tookOver: false };
        } catch (err) {
            if (errnoCode(err) !== "EEXIST") {
                throw err;
            }
        }

        let seen: PidFileState = { status: "none" };
        const outcome = await takeOverStaleClaimAsync(path, {
            arbiter: path,
            holderIsStale: (record) => {
                const state = holderState(record, opts.expected);
                seen = state;
                return reclaimable(state);
            },
        });

        if (outcome === "held") {
            return { status: "held", state: seen };
        }

        if (outcome === "taken") {
            try {
                await createPidFile(path);
                return { status: "claimed", tookOver: true };
            } catch (err) {
                if (errnoCode(err) !== "EEXIST") {
                    throw err;
                }
            }
        }

        logger.debug({ attempt, path }, "[pidfile] lost a takeover round; checking again");

        if (opts.retryMs) {
            await new Promise((resolve) => setTimeout(resolve, opts.retryMs));
        }
    }

    return { status: "lost" };
}
