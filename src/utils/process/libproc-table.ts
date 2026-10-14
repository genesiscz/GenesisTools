/**
 * The process table through the kernel (`sysctl(KERN_PROC)`, `KERN_PROCARGS2`, libproc), without spawning `ps`.
 *
 * Measured on 2026-10-12 (1,487 processes): the whole table costs about 1 ms of CPU, with every readable argv
 * about 12 ms, where one `ps -axo` cost 68 ms and `ps axeww` 142 ms of CPU.
 *
 * What it can and cannot read, all measured:
 *   - pid, parent, uid, start time, command name and controlling terminal: every process, any user.
 *   - argv and environment (`KERN_PROCARGS2`), RSS and CPU time (`PROC_PIDTASKINFO`): this user's processes only.
 *     `ps` is setuid root, which is why it reads the other users' too. A caller that needs those keeps `ps`.
 *   - the environment of a platform binary (`/bin/sh`, `/bin/sleep`) is withheld by the kernel, from `ps` as well.
 *
 * Every function answers null off macOS, when libSystem does not load, or when the start-up self-check (our own
 * row must carry our own parent pid and uid) fails, so the caller keeps its `ps` path. Struct sizes and offsets are
 * from the SDK headers (`sys/sysctl.h`, `sys/proc.h`, `sys/proc_info.h`), checked with `offsetof` in C on
 * 2026-10-12 (Darwin 25.3, arm64).
 */
import { CString } from "bun:ffi";
import { errnoNow, type LibSystem, libSystem } from "@genesiscz/utils/fs/native/libsystem";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("libproc-table");

const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_ALL = 0;
const KERN_PROC_PID = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const ENOMEM = 12;

/** `struct kinfo_proc` (648 bytes) and the fields read from it. */
const KINFO_PROC_SIZE = 648;
const KP_START_SEC = 0;
const KP_START_USEC = 8;
const KP_STAT = 36;
const KP_PID = 40;
const KP_COMM = 243;
const KP_COMM_SIZE = 17;
/** `kp_eproc.e_ucred.cr_uid`: the effective uid, what `ps -o uid` prints. */
const KP_UID = 420;
const KP_PPID = 560;
/** `kp_eproc.e_pgid`, right after `e_ppid`. */
const KP_PGID = 564;
const KP_TDEV = 572;
const SZOMB = 5;
/**
 * `p_stat` (`sys/proc.h`) as a `ps -o state=` letter. Every live process is `SRUN` at this level: `ps` tells R from
 * S (and I, idle over 20 s) by its threads' run states, so a live process reads S here and
 * {@link readProcessUsage}'s `running` says whether a thread is on a CPU. SIDL (being created) reads I.
 */
const STATE_LETTERS = ["?", "I", "S", "S", "T", "Z"];
const NODEV = -1;
const S_IFCHR = 0o020000;

/** `PROC_PIDTASKINFO` → `struct proc_taskinfo` (96 bytes): resident size, then user and system time in mach units. */
const PROC_PIDTASKINFO = 4;
const PROC_TASKINFO_SIZE = 96;
const PTI_RESIDENT_SIZE = 8;
const PTI_TOTAL_USER = 16;
const PTI_TOTAL_SYSTEM = 24;
/** `proc_taskinfo.pti_threadnum` and `pti_numrunning`, after six 64-bit fields and nine 32-bit counters. */
const PTI_THREADNUM = 84;
const PTI_NUMRUNNING = 88;
const PROC_PIDPATHINFO_MAXSIZE = 4096;

export interface ProcessTableRow {
    pid: number;
    ppid: number;
    /** Process group, as `ps -o pgid=` prints it. */
    pgid: number;
    /** Effective uid. */
    uid: number;
    /** Start time in epoch milliseconds (microsecond source, so finer than `ps lstart`). */
    startMs: number;
    /** The kernel's 16-byte command name (`p_comm`). */
    comm: string;
    zombie: boolean;
    /** S live, T stopped, Z zombie, I being created: `p_stat` cannot tell running from sleeping. */
    state: string;
    /** The controlling terminal as `ps -o tty=` prints it (`ttys003`), or null where `ps` prints `??`. */
    tty: string | null;
}

export interface ProcessArgs {
    /** The path the kernel executed. */
    execPath: string;
    argv: string[];
    /** `KEY=value` strings; empty when the kernel withholds them (another user, a platform binary). */
    env: string[];
}

export interface ProcessUsage {
    rssBytes: number;
    /** User plus system CPU time. */
    cpuTimeMs: number;
    /** Threads, as `ps -M` counts them. */
    threads: number;
    /** A thread is on a CPU right now: what makes `ps -o state=` print R rather than S. */
    running: boolean;
}

let selfCheck: "pending" | "ok" | "failed" = "pending";
const sizeWord = new BigUint64Array(1);
const mibAll = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_ALL]);
const mibPid = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_PID, 0]);
const mibArgs = new Int32Array([CTL_KERN, KERN_PROCARGS2, 0]);
const mibArgmax = new Int32Array([CTL_KERN, KERN_ARGMAX]);
const argmaxWord = new Int32Array(1);
const rowBuffer = new Uint8Array(KINFO_PROC_SIZE);
const taskWords = new Uint32Array(PROC_TASKINFO_SIZE / 4);
const timebaseWords = new Uint32Array(2);
const pathBuffer = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE);
let tableBuffer = new Uint8Array(0);
let argsBuffer: Buffer | null = null;
let nsPerMachUnit: number | null = null;
const ttyNames = new Map<number, string | null>();

/** The libSystem calls, or null when unavailable or when the self-check found the layout wrong. */
function calls(): LibSystem | null {
    const symbols = libSystem();

    if (!symbols || selfCheck === "failed") {
        return null;
    }

    if (selfCheck === "pending") {
        selfCheck = "ok";
        const own = readRowWith(symbols, process.pid);
        const euid = process.geteuid?.() ?? -1;

        if (!own || own.ppid !== process.ppid || own.uid !== euid) {
            selfCheck = "failed";
            log.warn(
                { own, ppid: process.ppid, euid },
                "libproc-table: our own row does not match this process; the kinfo_proc layout is not the one expected, callers keep ps"
            );
            return null;
        }
    }

    return symbols;
}

/** True when the kernel reads here work on this machine (macOS, libSystem loaded, self-check passed). */
export function processTableAvailable(): boolean {
    return calls() !== null;
}

function ttyName(symbols: LibSystem, dev: number): string | null {
    if (dev === NODEV) {
        return null;
    }

    const cached = ttyNames.get(dev);

    if (cached !== undefined) {
        return cached;
    }

    const name = symbols.devname(dev, S_IFCHR);
    const value = name ? new CString(name).toString() : null;
    ttyNames.set(dev, value);
    return value;
}

function decodeRow(symbols: LibSystem, bytes: Uint8Array, view: DataView, base: number): ProcessTableRow {
    const startSec =
        view.getUint32(base + KP_START_SEC, true) + view.getUint32(base + KP_START_SEC + 4, true) * 2 ** 32;
    const startUsec = view.getInt32(base + KP_START_USEC, true);
    let commEnd = base + KP_COMM;

    while (commEnd < base + KP_COMM + KP_COMM_SIZE && bytes[commEnd] !== 0) {
        commEnd++;
    }

    return {
        pid: view.getInt32(base + KP_PID, true),
        ppid: view.getInt32(base + KP_PPID, true),
        pgid: view.getInt32(base + KP_PGID, true),
        uid: view.getUint32(base + KP_UID, true),
        startMs: startSec * 1000 + Math.floor(startUsec / 1000),
        comm: Buffer.from(bytes.buffer, bytes.byteOffset + base + KP_COMM, commEnd - base - KP_COMM).toString("utf8"),
        zombie: bytes[base + KP_STAT] === SZOMB,
        state: STATE_LETTERS[bytes[base + KP_STAT]] ?? "?",
        tty: ttyName(symbols, view.getInt32(base + KP_TDEV, true)),
    };
}

function readRowWith(symbols: LibSystem, pid: number): ProcessTableRow | null {
    mibPid[3] = pid;
    sizeWord[0] = BigInt(KINFO_PROC_SIZE);

    if (symbols.sysctl(mibPid, 4, rowBuffer, sizeWord, null, 0) !== 0 || Number(sizeWord[0]) < KINFO_PROC_SIZE) {
        return null;
    }

    return decodeRow(symbols, rowBuffer, new DataView(rowBuffer.buffer), 0);
}

/** One process (any user), or null when it does not exist or the table is unavailable. */
export function readProcessRow(pid: number): ProcessTableRow | null {
    const symbols = calls();

    if (!symbols || !Number.isInteger(pid) || pid < 0) {
        return null;
    }

    return readRowWith(symbols, pid);
}

/** Every process on the machine, any user, from one `sysctl(KERN_PROC_ALL)`. Null when unavailable. */
export function listProcessTable(): ProcessTableRow[] | null {
    const symbols = calls();

    if (!symbols) {
        return null;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
        sizeWord[0] = 0n;

        if (symbols.sysctl(mibAll, 3, null, sizeWord, null, 0) !== 0) {
            log.warn({ errno: errnoNow(symbols) }, "sysctl(KERN_PROC_ALL) size query failed");
            return null;
        }

        // Room for processes started between the size query and the read.
        const needed = Number(sizeWord[0]) + 128 * KINFO_PROC_SIZE;

        if (tableBuffer.byteLength < needed) {
            tableBuffer = new Uint8Array(needed);
        }

        sizeWord[0] = BigInt(tableBuffer.byteLength);

        if (symbols.sysctl(mibAll, 3, tableBuffer, sizeWord, null, 0) === 0) {
            const count = Math.floor(Number(sizeWord[0]) / KINFO_PROC_SIZE);
            const view = new DataView(tableBuffer.buffer);
            const rows: ProcessTableRow[] = [];

            for (let index = 0; index < count; index++) {
                rows.push(decodeRow(symbols, tableBuffer, view, index * KINFO_PROC_SIZE));
            }

            return rows;
        }

        const errno = errnoNow(symbols);

        if (errno !== ENOMEM) {
            log.warn({ errno }, "sysctl(KERN_PROC_ALL) failed");
            return null;
        }
    }

    log.warn("sysctl(KERN_PROC_ALL) kept growing past four attempts");
    return null;
}

function argumentBuffer(symbols: LibSystem): Buffer {
    if (argsBuffer) {
        return argsBuffer;
    }

    sizeWord[0] = 4n;
    const argmax = symbols.sysctl(mibArgmax, 2, argmaxWord, sizeWord, null, 0) === 0 ? argmaxWord[0] : 0;
    argsBuffer = Buffer.alloc(argmax > 0 ? argmax : 1024 * 1024);
    return argsBuffer;
}

/**
 * The bytes of one argument as `ps` prints them: newline and tab as octal (`\012`, `\011`), every other control
 * byte as `^X`, DEL as `^?`, everything else (backslash, UTF-8) as it is. Measured against `ps -o command=` and
 * `ps axww -o args=` on 2026-10-12. Identity checks compare a stored `ps` command line with this one, so it must be
 * byte-exact.
 */
function psText(buffer: Buffer, start: number, end: number): string {
    let plain = true;

    for (let index = start; index < end; index++) {
        if (buffer[index] < 0x20 || buffer[index] === 0x7f) {
            plain = false;
            break;
        }
    }

    if (plain) {
        return buffer.toString("utf8", start, end);
    }

    const parts: string[] = [];
    let from = start;

    for (let index = start; index < end; index++) {
        const byte = buffer[index];

        if (byte >= 0x20 && byte !== 0x7f) {
            continue;
        }

        parts.push(buffer.toString("utf8", from, index));

        if (byte === 0x0a) {
            parts.push("\\012");
        } else if (byte === 0x09) {
            parts.push("\\011");
        } else if (byte === 0x7f) {
            parts.push("^?");
        } else {
            parts.push(`^${String.fromCharCode(byte + 64)}`);
        }

        from = index + 1;
    }

    parts.push(buffer.toString("utf8", from, end));
    return parts.join("");
}

function readArgsWith(
    symbols: LibSystem,
    pid: number,
    options: { env: boolean; psEncoded: boolean }
): ProcessArgs | null {
    const buffer = argumentBuffer(symbols);
    mibArgs[2] = pid;
    sizeWord[0] = BigInt(buffer.byteLength);

    // Another user's process, a zombie or a pid that is gone: the kernel refuses (EINVAL / EPERM).
    if (symbols.sysctl(mibArgs, 3, buffer, sizeWord, null, 0) !== 0) {
        return null;
    }

    const size = Number(sizeWord[0]);

    if (size < 4) {
        return null;
    }

    const text = (start: number, end: number) =>
        options.psEncoded ? psText(buffer, start, end) : buffer.toString("utf8", start, end);
    const argc = buffer.readInt32LE(0);
    let offset = 4;
    let end = buffer.indexOf(0, offset);

    if (end === -1 || end >= size) {
        return null;
    }

    const execPath = buffer.toString("utf8", offset, end);
    offset = end;

    while (offset < size && buffer[offset] === 0) {
        offset++;
    }

    const argv: string[] = [];

    for (let index = 0; index < argc && offset < size; index++) {
        end = buffer.indexOf(0, offset);

        if (end === -1 || end > size) {
            end = size;
        }

        argv.push(text(offset, end));
        offset = end + 1;
    }

    const env: string[] = [];

    // The environment ends at the first empty string; the "apple" strings after it are not environment.
    while (options.env && offset < size) {
        end = buffer.indexOf(0, offset);

        if (end === -1 || end > size) {
            end = size;
        }

        if (end === offset) {
            break;
        }

        env.push(text(offset, end));
        offset = end + 1;
    }

    return { execPath, argv, env };
}

/** argv (and the environment when asked) of one of this user's processes; null for anyone else's or a zombie. */
export function readProcessArgs(pid: number, options: { env?: boolean } = {}): ProcessArgs | null {
    const symbols = calls();

    if (!symbols) {
        return null;
    }

    return readArgsWith(symbols, pid, { env: options.env === true, psEncoded: false });
}

/**
 * The command line exactly as `ps -o command=` prints it (argv joined by single spaces, control bytes escaped, the
 * end trimmed), or with `env` the environment appended as `ps eww` does. Null for a process whose argv the kernel
 * withholds from this user; the caller asks `ps` for those.
 */
export function readPsCommand(pid: number, options: { env?: boolean } = {}): string | null {
    const symbols = calls();

    if (!symbols) {
        return null;
    }

    const args = readArgsWith(symbols, pid, { env: options.env === true, psEncoded: true });

    if (!args) {
        return null;
    }

    return [...args.argv, ...args.env].join(" ").trim();
}

/** The executable of any process (`proc_pidpath` answers for other users too), or null. */
export function readProcessPath(pid: number): string | null {
    const symbols = calls();

    if (!symbols) {
        return null;
    }

    const length = symbols.proc_pidpath(pid, pathBuffer, PROC_PIDPATHINFO_MAXSIZE);
    return length > 0 ? pathBuffer.toString("utf8", 0, length) : null;
}

/** RSS and CPU time of one of this user's processes, or null for anyone else's, a zombie, or a pid that is gone. */
export function readProcessUsage(pid: number): ProcessUsage | null {
    const symbols = calls();

    if (!symbols) {
        return null;
    }

    if (nsPerMachUnit === null) {
        nsPerMachUnit =
            symbols.mach_timebase_info(timebaseWords) === 0 && timebaseWords[1] > 0
                ? timebaseWords[0] / timebaseWords[1]
                : 1;
    }

    if (symbols.proc_pidinfo(pid, PROC_PIDTASKINFO, 0n, taskWords, PROC_TASKINFO_SIZE) !== PROC_TASKINFO_SIZE) {
        return null;
    }

    const word = (offset: number) => taskWords[offset / 4] + taskWords[offset / 4 + 1] * 2 ** 32;
    // Each part in whole microseconds, as `ps` takes them before it adds and rounds.
    const userUs = Math.floor((word(PTI_TOTAL_USER) * nsPerMachUnit) / 1000);
    const systemUs = Math.floor((word(PTI_TOTAL_SYSTEM) * nsPerMachUnit) / 1000);

    return {
        rssBytes: word(PTI_RESIDENT_SIZE),
        cpuTimeMs: (userUs + systemUs) / 1000,
        threads: taskWords[PTI_THREADNUM / 4],
        running: taskWords[PTI_NUMRUNNING / 4] > 0,
    };
}

/**
 * `ps -o time=` on macOS: minutes (never hours), seconds and hundredths rounded to nearest, `79:56.43`. Measured
 * against `ps` on 150 idle processes on 2026-10-12: 142 equal, 8 one hundredth below what `ps` printed.
 */
export function formatPsCpuTime(cpuTimeMs: number): string {
    const hundredths = Math.floor((Math.round(cpuTimeMs * 1000) + 5000) / 10000);
    const seconds = Math.floor(hundredths / 100);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}

/**
 * The command of a table row as `ps -o command=` would print it, as far as this user can read it: the escaped argv
 * of our own processes, `<defunct>` for a zombie, else the executable path, else `(comm)`. Only the first is what
 * `ps` prints; for another user's process `ps` (setuid root) would print its full argv.
 */
export function commandOfRow(row: ProcessTableRow): string {
    if (row.zombie) {
        return "<defunct>";
    }

    const euid = process.geteuid?.() ?? -1;
    // The kernel withholds another user's argv from us (unless we are root), so do not ask for it.
    const command = row.uid === euid || euid === 0 ? readPsCommand(row.pid) : null;
    return command ?? readProcessPath(row.pid) ?? `(${row.comm})`;
}
