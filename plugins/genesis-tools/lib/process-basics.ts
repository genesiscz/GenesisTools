/**
 * One process's parent, name, command line, terminal and start time, and the whole table of parents and start
 * times, with NO dependency beyond `node:` and `bun:`. For the code that cannot import `@genesiscz`: the plugin's
 * hooks (Claude Code and Codex run them from a plugin cache without this repo), `scripts/test-reap.ts` (runs before
 * the dependency repair) and `src/utils/bun/orphan-worker-guard.ts` (loaded by isolated test workers).
 *
 * Two byte-identical copies: `src/utils/process/process-basics.ts` and `plugins/genesis-tools/lib/process-basics.ts`
 * (`process-basics.test.ts` fails when they differ, and compares both with `@genesiscz/utils/process`). Edit the
 * `src` one, then copy it over the plugin one.
 *
 * - macOS: `sysctl(KERN_PROC_PID | KERN_PROC_ALL)` and `KERN_PROCARGS2` through `bun:ffi`, microseconds where one
 *   `ps -p` costs about 6 ms. The kernel withholds another user's argv; only then does `ps` (setuid) run, once.
 * - Linux: `/proc/<pid>/stat` and `cmdline`.
 * - Anywhere else, or when the macOS self-check fails: one `ps`.
 */
import { CString, dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";

export interface ProcessBasics {
    pid: number;
    ppid: number;
    /** The kernel's short name (`p_comm`, Linux comm). */
    name: string;
    /** As `ps -o command=` prints it; null when even `ps` cannot read it. */
    command: string | null;
    /** As `ps -o tty=` prints it (`ttys003`, `pts/2`); null for none. */
    tty: string | null;
    /** Epoch ms; null when unknown. */
    startMs: number | null;
}

/** Offsets in `struct kinfo_proc` (648 bytes), the same as `src/utils/process/libproc-table.ts`. */
const KINFO_PROC_SIZE = 648;
const KP_START_SEC = 0;
const KP_START_USEC = 8;
const KP_PID = 40;
const KP_COMM = 243;
const KP_COMM_SIZE = 17;
const KP_PPID = 560;
const KP_TDEV = 572;
const NODEV = -1;
const S_IFCHR = 0o020000;
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_ALL = 0;
const KERN_PROC_PID = 1;
const ENOMEM = 12;
const KERN_PROCARGS2 = 49;
/** Big enough for any argv; `KERN_ARGMAX` is 1 MB on current macOS. */
const ARGS_BUFFER_SIZE = 1024 * 1024;

type Darwin = {
    errno: () => number;
    sysctl: (
        mib: Int32Array,
        count: number,
        out: Uint8Array | null,
        size: BigUint64Array,
        input: null,
        inputSize: number
    ) => number;
    devname: (dev: number, type: number) => Pointer | null;
};

let darwin: Darwin | null | undefined;

function loadDarwin(): Darwin | null {
    if (darwin !== undefined) {
        return darwin;
    }

    darwin = null;

    if (process.platform !== "darwin") {
        return darwin;
    }

    try {
        const lib = dlopen("/usr/lib/libSystem.B.dylib", {
            sysctl: {
                args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
                returns: FFIType.i32,
            },
            devname: { args: [FFIType.i32, FFIType.u16], returns: FFIType.ptr },
            __error: { args: [], returns: FFIType.ptr },
        });
        const errorPointer = lib.symbols.__error;
        const symbols = {
            ...(lib.symbols as unknown as Omit<Darwin, "errno">),
            errno: () => {
                const address = errorPointer();
                return address ? read.i32(address, 0) : 0;
            },
        };
        // Self-check: our own row must carry our own parent pid, or the layout is not the one expected.
        darwin = symbols;

        if (readDarwinRow(process.pid)?.ppid !== process.ppid) {
            darwin = null;
        }
    } catch {
        darwin = null;
    }

    return darwin;
}

const mibAll = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_ALL]);
const mibPid = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_PID, 0]);
const mibArgs = new Int32Array([CTL_KERN, KERN_PROCARGS2, 0]);
const sizeWord = new BigUint64Array(1);
const rowBuffer = new Uint8Array(KINFO_PROC_SIZE);
let argsBuffer: Buffer | null = null;

// devname() costs about 0.5 ms a call, and a terminal holds many processes: 104 rows on 10 terminals took 52 ms
// uncached. A pty's device number always names the same /dev entry, so a name is looked up once.
const ttyNames = new Map<number, string | null>();

/**
 * The `/dev` name of every terminal device, read once: one `readdir` and a `stat` per `tty*` entry cost about 1 ms,
 * while `devname()` costs about 0.5 ms a call. A terminal opened later is not in it, and falls back to `devname()`.
 */
function terminalNames(): Map<number, string> {
    const names = new Map<number, string>();

    try {
        for (const name of readdirSync("/dev")) {
            if (name.startsWith("tty") || name === "console") {
                try {
                    names.set(statSync(`/dev/${name}`).rdev, name);
                } catch {
                    // Gone between the readdir and the stat.
                }
            }
        }
    } catch {
        // No /dev listing: every lookup goes to devname().
    }

    return names;
}

function ttyName(lib: Darwin, dev: number): string | null {
    if (dev === NODEV) {
        return null;
    }

    if (ttyNames.size === 0) {
        for (const [device, terminal] of terminalNames()) {
            ttyNames.set(device, terminal);
        }
    }

    let name = ttyNames.get(dev);

    if (name === undefined) {
        const pointer = lib.devname(dev, S_IFCHR);
        name = pointer ? new CString(pointer).toString() : null;
        ttyNames.set(dev, name);
    }

    return name;
}

function decodeDarwinRow(lib: Darwin, bytes: Uint8Array, base: number, view: DataView): Omit<ProcessBasics, "command"> {
    const startSec =
        view.getUint32(base + KP_START_SEC, true) + view.getUint32(base + KP_START_SEC + 4, true) * 2 ** 32;
    let commEnd = base + KP_COMM;

    while (commEnd < base + KP_COMM + KP_COMM_SIZE && bytes[commEnd] !== 0) {
        commEnd++;
    }

    return {
        pid: view.getInt32(base + KP_PID, true),
        ppid: view.getInt32(base + KP_PPID, true),
        name: Buffer.from(bytes.buffer, bytes.byteOffset + base + KP_COMM, commEnd - base - KP_COMM).toString("utf8"),
        tty: ttyName(lib, view.getInt32(base + KP_TDEV, true)),
        startMs: startSec * 1000 + Math.floor(view.getInt32(base + KP_START_USEC, true) / 1000),
    };
}

function readDarwinRow(pid: number): Omit<ProcessBasics, "command"> | null {
    const lib = darwin;

    if (!lib) {
        return null;
    }

    mibPid[3] = pid;
    sizeWord[0] = BigInt(KINFO_PROC_SIZE);

    if (lib.sysctl(mibPid, 4, rowBuffer, sizeWord, null, 0) !== 0 || Number(sizeWord[0]) < KINFO_PROC_SIZE) {
        return null;
    }

    return decodeDarwinRow(lib, rowBuffer, 0, new DataView(rowBuffer.buffer));
}

function readDarwinTable(lib: Darwin): Omit<ProcessBasics, "command">[] | null {
    for (let attempt = 0; attempt < 4; attempt++) {
        sizeWord[0] = 0n;

        if (lib.sysctl(mibAll, 3, null, sizeWord, null, 0) !== 0) {
            return null;
        }

        // Room for processes started between the size query and the read.
        const table = new Uint8Array(Number(sizeWord[0]) + 128 * KINFO_PROC_SIZE);
        sizeWord[0] = BigInt(table.byteLength);

        if (lib.sysctl(mibAll, 3, table, sizeWord, null, 0) === 0) {
            const rows: Omit<ProcessBasics, "command">[] = [];
            const view = new DataView(table.buffer);

            for (let base = 0; base + KINFO_PROC_SIZE <= Number(sizeWord[0]); base += KINFO_PROC_SIZE) {
                rows.push(decodeDarwinRow(lib, table, base, view));
            }

            return rows;
        }

        if (lib.errno() !== ENOMEM) {
            return null;
        }
    }

    return null;
}

/** One argument as `ps` prints it: newline and tab as `\012` and `\011`, other control bytes as `^X`. */
function psText(buffer: Buffer, start: number, end: number): string {
    let text = "";

    for (let index = start; index < end; index++) {
        const byte = buffer[index];

        if (byte >= 0x20 && byte !== 0x7f) {
            continue;
        }

        text += buffer.toString("utf8", start, index);
        text +=
            byte === 0x0a
                ? "\\012"
                : byte === 0x09
                  ? "\\011"
                  : byte === 0x7f
                    ? "^?"
                    : `^${String.fromCharCode(byte + 64)}`;
        start = index + 1;
    }

    return text + buffer.toString("utf8", start, end);
}

/** The command line from `KERN_PROCARGS2`; null for another user's process or a zombie. */
function readDarwinCommand(pid: number): string | null {
    const lib = darwin;

    if (!lib) {
        return null;
    }

    argsBuffer ??= Buffer.alloc(ARGS_BUFFER_SIZE);
    mibArgs[2] = pid;
    sizeWord[0] = BigInt(argsBuffer.byteLength);

    if (lib.sysctl(mibArgs, 3, argsBuffer, sizeWord, null, 0) !== 0) {
        return null;
    }

    const size = Number(sizeWord[0]);

    if (size < 4) {
        return null;
    }

    const argc = argsBuffer.readInt32LE(0);
    let offset = argsBuffer.indexOf(0, 4);

    if (offset === -1 || offset >= size) {
        return null;
    }

    while (offset < size && argsBuffer[offset] === 0) {
        offset++;
    }

    const argv: string[] = [];

    for (let index = 0; index < argc && offset < size; index++) {
        let end = argsBuffer.indexOf(0, offset);

        if (end === -1 || end > size) {
            end = size;
        }

        argv.push(psText(argsBuffer, offset, end));
        offset = end + 1;
    }

    return argv.join(" ").trim();
}

function ttyFromLinux(ttyNr: number): string | null {
    if (!ttyNr) {
        return null;
    }

    const major = (ttyNr >> 8) & 0xfff;
    const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);

    if (major >= 136 && major <= 143) {
        return `pts/${(major - 136) * 256 + minor}`;
    }

    return major === 4 ? (minor < 64 ? `tty${minor}` : `ttyS${minor - 64}`) : null;
}

function readLinux(pid: number): ProcessBasics | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const open = stat.indexOf("(");
        const close = stat.lastIndexOf(")");
        const fields = stat
            .slice(close + 1)
            .trim()
            .split(/\s+/);
        const boot = readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)$/m);
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        const name = stat.slice(open + 1, close);

        return {
            pid,
            ppid: Number(fields[1]),
            name,
            command: argv.length > 0 ? argv.join(" ") : `[${name}]`,
            tty: ttyFromLinux(Number(fields[4])),
            // starttime (stat field 22) counts USER_HZ ticks after boot; USER_HZ is 100 on mainstream builds.
            startMs: boot ? Number(boot[1]) * 1000 + Number(fields[19]) * 10 : null,
        };
    } catch {
        return null;
    }
}

function readLinuxTable(): Omit<ProcessBasics, "command">[] {
    let names: string[];

    try {
        names = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
    } catch {
        return [];
    }

    return names.flatMap((name) => {
        const basics = readLinux(Number(name));
        return basics
            ? [{ pid: basics.pid, ppid: basics.ppid, name: basics.name, tty: basics.tty, startMs: basics.startMs }]
            : [];
    });
}

function runPs(args: string[]): string | null {
    // lint-rules-ignore: the plugin's process layer; ps runs only where the kernel read cannot answer
    const result = spawnSync("ps", args, { encoding: "utf8", timeout: 2000 });
    return result.status === 0 ? result.stdout : null;
}

function readWithPs(pid: number): ProcessBasics | null {
    const out = runPs(["-o", "ppid=,tty=,lstart=,comm=", "-p", String(pid)]);
    const match = out?.match(/^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/m);

    if (!match) {
        return null;
    }

    const started = Date.parse(match[3]);

    return {
        pid,
        ppid: Number(match[1]),
        name: match[4].trim().split("/").pop() ?? "",
        command: runPs(["-o", "command=", "-p", String(pid)])?.trim() || null,
        tty: match[2] === "??" || match[2] === "?" ? null : match[2],
        startMs: Number.isNaN(started) ? null : started,
    };
}

/** One process, or null when it is gone. */
export function readProcessBasics(pid: number): ProcessBasics | null {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    if (process.platform === "linux") {
        return readLinux(pid);
    }

    if (!loadDarwin()) {
        return readWithPs(pid);
    }

    const row = readDarwinRow(pid);

    if (!row) {
        return null;
    }

    // The kernel withholds another user's argv; the setuid ps can still read it.
    const command = readDarwinCommand(pid) ?? (runPs(["-o", "command=", "-p", String(pid)])?.trim() || null);
    return { ...row, command };
}

/** Every process's pid, parent, name, terminal and start time, from one kernel read (`/proc` on Linux). */
export function listProcessBasics(): Omit<ProcessBasics, "command">[] {
    if (process.platform === "linux") {
        return readLinuxTable();
    }

    const lib = loadDarwin();
    const table = lib ? readDarwinTable(lib) : null;

    if (table) {
        return table;
    }

    const out = runPs(["-Ao", "pid=,ppid=,tty=,lstart=,comm="]) ?? "";
    return out.split("\n").flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);

        if (!match) {
            return [];
        }

        const started = Date.parse(match[4]);
        return [
            {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                name: match[5].trim().split("/").pop() ?? "",
                tty: match[3] === "??" || match[3] === "?" ? null : match[3],
                startMs: Number.isNaN(started) ? null : started,
            },
        ];
    });
}

/**
 * The time zone a child `ps` prints in: `TZ` from the environment it inherits, else the system zone that
 * `/etc/localtime` links to. Not JavaScript's zone: `bun test` runs its clock in UTC without putting `TZ` in the
 * environment, so `new Date().getHours()` and `ps` disagree there.
 */
export function systemTimeZone(): string | undefined {
    const fromEnv = process.env.TZ?.replace(/^:/, "");

    if (fromEnv) {
        // A path (`:/etc/localtime`, `/usr/share/zoneinfo/Europe/Prague`) names its zone by where it links or lies.
        return fromEnv.startsWith("/") ? zoneOfFile(fromEnv) : fromEnv;
    }

    return zoneOfFile("/etc/localtime");
}

/** The IANA zone a zoneinfo file stands for: the path it links to, or its own path when it is no link. */
function zoneOfFile(path: string): string | undefined {
    let target = path;

    try {
        target = readlinkSync(path);
    } catch {
        // Not a link: the file's own path names the zone, or nothing does.
    }

    return target.split("zoneinfo/")[1];
}

const lstartFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * `Intl` takes only IANA zone names. A POSIX `TZ` such as `CET-1CEST,M3.5.0,M10.5.0/3`, which `ps` accepts, made it
 * throw a RangeError; such a zone falls back to the runtime's own.
 */
function lstartFormat(timeZone: string | undefined): Intl.DateTimeFormat {
    const options: Intl.DateTimeFormatOptions = {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        year: "numeric",
        hourCycle: "h23",
    };

    try {
        return new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    } catch {
        return new Intl.DateTimeFormat("en-US", options);
    }
}

/**
 * A start time as `ps -o lstart=` prints it, `Tue Oct  7 01:40:00 2026` (the day padded to two characters), in the
 * zone `ps` uses ({@link systemTimeZone}). Byte-equal to `ps`, so a stored `ps` start string still compares.
 */
export function formatLstart(ms: number, timeZone = systemTimeZone()): string {
    const key = timeZone ?? "";
    let format = lstartFormats.get(key);

    if (!format) {
        format = lstartFormat(timeZone);
        lstartFormats.set(key, format);
    }

    // One formatToParts per call: it is the expensive part, and a table of 1,300 processes formats 1,300 times.
    const parts = new Map(format.formatToParts(ms).map((candidate) => [candidate.type, candidate.value]));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? "";
    const time = `${part("hour")}:${part("minute")}:${part("second")}`;
    return `${part("weekday")} ${part("month")} ${part("day").padStart(2, " ")} ${time} ${part("year")}`;
}
