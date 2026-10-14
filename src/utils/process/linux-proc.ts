/**
 * Linux process reads from `/proc`, the same files `ps` and `lsof` read, without starting either. Every reader
 * takes the `/proc` root, so the parsers are tested on fixtures on any OS. A file that is missing or unreadable
 * (the process exited, or belongs to another user and hides it) answers null, never throws.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const PROC_ROOT = "/proc";
/**
 * Linux reports CPU and start times in clock ticks. USER_HZ is 100 on every mainstream build and there is no
 * cheap userspace way to read the real value, so this assumes it.
 */
export const LINUX_USER_HZ = 100;

export interface ProcStat {
    pid: number;
    /** The task name, at most 15 bytes, without the parentheses. */
    comm: string;
    /** One letter: R running, S sleeping, Z zombie, T stopped, … */
    state: string;
    ppid: number;
    /** Process group (stat field 5). */
    pgid: number;
    /** The controlling terminal as major/minor packed by the kernel; 0 when there is none. */
    ttyNr: number;
    utimeTicks: number;
    stimeTicks: number;
    /** Start time in ticks after boot. */
    startTicks: number;
    threads: number;
    rssPages: number;
}

/**
 * Parses one `/proc/<pid>/stat` line. The comm field can hold spaces and parentheses, so everything up to the LAST
 * `)` is the comm and the rest is split; index 0 after it is the state (stat field 3), so field N sits at N - 3.
 */
export function parseProcStat(text: string): ProcStat | null {
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");

    if (open < 0 || close < open) {
        return null;
    }

    const fields = text
        .slice(close + 1)
        .trim()
        .split(/\s+/);
    const num = (field: number) => Number(fields[field - 3]);
    const stat: ProcStat = {
        pid: Number(text.slice(0, open).trim()),
        comm: text.slice(open + 1, close),
        state: fields[0] ?? "",
        ppid: num(4),
        pgid: num(5),
        ttyNr: num(7),
        utimeTicks: num(14),
        stimeTicks: num(15),
        threads: num(20),
        startTicks: num(22),
        rssPages: num(24),
    };

    return Number.isFinite(stat.pid) && Number.isFinite(stat.ppid) && Number.isFinite(stat.startTicks) ? stat : null;
}

/** utime + stime of a `/proc/<pid>/stat` line, in ms. */
export function parseProcStatCpuMs(stat: string): number | null {
    const parsed = parseProcStat(stat);

    if (!parsed || !Number.isFinite(parsed.utimeTicks) || !Number.isFinite(parsed.stimeTicks)) {
        return null;
    }

    return ((parsed.utimeTicks + parsed.stimeTicks) * 1000) / LINUX_USER_HZ;
}

/** `Threads:\t7` out of a `/proc/<pid>/status` body. */
export function parseProcThreads(status: string): number | null {
    const match = status.match(/^Threads:\s+(\d+)$/m);
    return match ? Number(match[1]) : null;
}

/** `VmRSS:\t  12345 kB` out of a `/proc/<pid>/status` body, in bytes. */
export function parseProcRssBytes(status: string): number | null {
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
}

/** The effective uid from `Uid:\t<real>\t<effective>\t…` of a `/proc/<pid>/status` body. */
export function parseProcUid(status: string): number | null {
    const match = status.match(/^Uid:\s+\d+\s+(\d+)/m);
    return match ? Number(match[1]) : null;
}

/** A NUL-separated `cmdline` or `environ` body as its strings (the trailing NUL ends the last one). */
export function parseNulList(body: string): string[] {
    return body.split("\0").filter((part, index, parts) => part !== "" || index < parts.length - 1);
}

/**
 * The terminal name `ps -o tty=` prints for a packed `tty_nr`: `pts/3` for a pseudo-terminal (majors 136 to 143),
 * `tty1` for a virtual console (major 4, minors under 64), `ttyS0` for a serial port, null for none or an unknown device.
 */
export function ttyName(ttyNr: number): string | null {
    if (!ttyNr) {
        return null;
    }

    const major = (ttyNr >> 8) & 0xfff;
    const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);

    if (major >= 136 && major <= 143) {
        return `pts/${(major - 136) * 256 + minor}`;
    }

    if (major === 4) {
        return minor < 64 ? `tty${minor}` : `ttyS${minor - 64}`;
    }

    return null;
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

/** System boot, ms since the epoch, from `btime` in `/proc/stat`. */
export function bootTimeMs(root = PROC_ROOT): number | null {
    const match = readText(join(root, "stat"))?.match(/^btime\s+(\d+)$/m);
    return match ? Number(match[1]) * 1000 : null;
}

/** Every pid with a directory under the root. */
export function listProcPids(root = PROC_ROOT): number[] {
    try {
        return readdirSync(root)
            .filter((name) => /^\d+$/.test(name))
            .map(Number);
    } catch {
        return [];
    }
}

export interface LinuxProcess {
    pid: number;
    ppid: number;
    pgid: number;
    uid: number | null;
    comm: string;
    /** The argv; empty for a kernel thread or a zombie. */
    argv: string[];
    state: string;
    tty: string | null;
    startMs: number | null;
    cpuTimeMs: number;
    rssBytes: number;
    threads: number;
}

/** One process from `stat`, `status` and `cmdline`; null when its directory is gone. */
export function readProcProcess(pid: number, root = PROC_ROOT, bootMs = bootTimeMs(root)): LinuxProcess | null {
    const dir = join(root, String(pid));
    const statText = readText(join(dir, "stat"));
    const stat = statText === null ? null : parseProcStat(statText);

    if (!stat) {
        return null;
    }

    const status = readText(join(dir, "status")) ?? "";
    const cmdline = readText(join(dir, "cmdline")) ?? "";

    return {
        pid,
        ppid: stat.ppid,
        pgid: stat.pgid,
        uid: parseProcUid(status),
        comm: stat.comm,
        argv: parseNulList(cmdline),
        state: stat.state,
        tty: ttyName(stat.ttyNr),
        startMs: bootMs === null ? null : bootMs + (stat.startTicks * 1000) / LINUX_USER_HZ,
        cpuTimeMs: ((stat.utimeTicks + stat.stimeTicks) * 1000) / LINUX_USER_HZ,
        rssBytes: parseProcRssBytes(status) ?? 0,
        threads: stat.threads,
    };
}

/** Every readable process. */
export function listProcProcesses(root = PROC_ROOT): LinuxProcess[] {
    const bootMs = bootTimeMs(root);
    return listProcPids(root).flatMap((pid) => readProcProcess(pid, root, bootMs) ?? []);
}

/** `KEY=value` strings of the process environment; null for another user's process. */
export function readProcEnviron(pid: number, root = PROC_ROOT): string[] | null {
    const body = readText(join(root, String(pid), "environ"));
    return body === null ? null : parseNulList(body);
}

function readLink(path: string): string | null {
    try {
        return readlinkSync(path);
    } catch {
        return null;
    }
}

/** The executable's path (`/proc/<pid>/exe`); null for another user's process or a kernel thread. */
export function readProcExe(pid: number, root = PROC_ROOT): string | null {
    return readLink(join(root, String(pid), "exe"));
}

/** How many descriptors the process has open; null when its `fd` directory is unreadable. */
export function countProcFds(pid: number, root = PROC_ROOT): number | null {
    try {
        return readdirSync(join(root, String(pid), "fd")).length;
    } catch {
        return null;
    }
}

/** TCP states in `/proc/net/tcp` (`include/net/tcp_states.h`). */
export const TCP_ESTABLISHED = 0x01;
export const TCP_LISTEN = 0x0a;

export interface ProcTcpRow {
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    state: number;
    inode: number;
}

function decodeIpv4(hex: string): string {
    const n = Number.parseInt(hex, 16);
    return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff].join(".");
}

function decodeIpv6(hex: string): string {
    // Four 32-bit words, each in host (little-endian) byte order.
    const bytes: number[] = [];

    for (let word = 0; word < 4; word++) {
        const chunk = hex.slice(word * 8, word * 8 + 8);
        bytes.push(...[6, 4, 2, 0].map((at) => Number.parseInt(chunk.slice(at, at + 2), 16)));
    }

    const groups: string[] = [];

    for (let i = 0; i < 16; i += 2) {
        groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    }

    // An IPv4-mapped address prints with its IPv4 tail, as inet_ntop does: `::ffff:127.0.0.1`.
    if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
        return `::ffff:${bytes.slice(12).join(".")}`;
    }

    // The longest run of two or more zero groups becomes `::`, as inet_ntop prints it.
    let bestStart = -1;
    let bestLength = 0;

    for (let i = 0; i < groups.length; ) {
        let end = i;

        while (end < groups.length && groups[end] === "0") {
            end++;
        }

        if (end - i >= 2 && end - i > bestLength) {
            bestStart = i;
            bestLength = end - i;
        }

        i = end === i ? i + 1 : end;
    }

    if (bestStart === -1) {
        return groups.join(":");
    }

    return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
}

function decodeEndpoint(field: string): { address: string; port: number } {
    const [hexAddress = "", hexPort = "0"] = field.split(":");
    return {
        address: hexAddress.length > 8 ? decodeIpv6(hexAddress) : decodeIpv4(hexAddress),
        port: Number.parseInt(hexPort, 16),
    };
}

/** Parses `/proc/net/tcp` or `/proc/net/tcp6` (the header line is skipped). */
export function parseProcNetTcp(body: string): ProcTcpRow[] {
    const rows: ProcTcpRow[] = [];

    for (const line of body.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);

        if (parts.length < 10) {
            continue;
        }

        const local = decodeEndpoint(parts[1]);
        const remote = decodeEndpoint(parts[2]);
        rows.push({
            localAddress: local.address,
            localPort: local.port,
            remoteAddress: remote.address,
            remotePort: remote.port,
            state: Number.parseInt(parts[3], 16),
            inode: Number(parts[9]),
        });
    }

    return rows;
}

/** A complete protocol snapshot; a missing IPv6 table is normal when IPv6 is disabled. */
export function scanProcNet(protocol: "tcp" | "udp", root = PROC_ROOT): ProcTcpRow[] | null {
    const ipv4 = readText(join(root, "net", protocol));

    if (ipv4 === null) {
        return null;
    }

    let ipv6 = "";

    try {
        ipv6 = readFileSync(join(root, "net", `${protocol}6`), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return null;
        }
    }

    return [...parseProcNetTcp(ipv4), ...parseProcNetTcp(ipv6)];
}

/** Both TCP tables. */
export function readProcTcp(root = PROC_ROOT): ProcTcpRow[] {
    return [
        ...parseProcNetTcp(readText(join(root, "net", "tcp")) ?? ""),
        ...parseProcNetTcp(readText(join(root, "net", "tcp6")) ?? ""),
    ];
}

/** Both UDP tables; same line format as TCP, where state 07 means unconnected. */
export function readProcUdp(root = PROC_ROOT): ProcTcpRow[] {
    return [
        ...parseProcNetTcp(readText(join(root, "net", "udp")) ?? ""),
        ...parseProcNetTcp(readText(join(root, "net", "udp6")) ?? ""),
    ];
}

/** TCP state names by `/proc/net/tcp` value (`include/net/tcp_states.h`), as lsof prints them. */
export const TCP_STATE_NAMES: Record<number, string> = {
    1: "ESTABLISHED",
    2: "SYN_SENT",
    3: "SYN_RECV",
    4: "FIN_WAIT1",
    5: "FIN_WAIT2",
    6: "TIME_WAIT",
    7: "CLOSE",
    8: "CLOSE_WAIT",
    9: "LAST_ACK",
    10: "LISTEN",
    11: "CLOSING",
};

export interface ProcFd {
    fd: number;
    /** The link target: a path, `socket:[123]`, `pipe:[456]`, `anon_inode:[eventpoll]`. */
    target: string;
    /** lsof's mode letter from `fdinfo` flags: `r`, `w` or `u`. */
    mode: string;
}

/** `flags:\t0100002` of a `/proc/<pid>/fdinfo/<fd>` body as lsof's mode letter (O_ACCMODE: 0 read, 1 write, 2 both). */
export function parseFdinfoMode(body: string): string {
    const match = body.match(/^flags:\s+([0-7]+)$/m);
    const access = match ? Number.parseInt(match[1], 8) & 3 : -1;
    return access === 0 ? "r" : access === 1 ? "w" : access === 2 ? "u" : "";
}

/** Every descriptor of the process with its target; null when its `fd` directory is unreadable. */
export function listProcFds(pid: number, root = PROC_ROOT): ProcFd[] | null {
    let names: string[];

    try {
        names = readdirSync(join(root, String(pid), "fd"));
    } catch {
        return null;
    }

    return names
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((fd) => {
            const target = readLink(join(root, String(pid), "fd", String(fd)));
            const fdinfo = readText(join(root, String(pid), "fdinfo", String(fd))) ?? "";
            return target === null ? [] : [{ fd, target, mode: parseFdinfoMode(fdinfo) }];
        });
}

/** The working directory (`/proc/<pid>/cwd`); null for another user's process. */
export function readProcCwd(pid: number, root = PROC_ROOT): string | null {
    return readLink(join(root, String(pid), "cwd"));
}

/** Socket inode to all owning pids, from each readable process's `fd` links (`socket:[<inode>]`). */
export function socketInodeOwners(root = PROC_ROOT, pids = listProcPids(root)): Map<number, Set<number>> {
    const owners = new Map<number, Set<number>>();

    for (const pid of pids) {
        let fds: string[];

        try {
            fds = readdirSync(join(root, String(pid), "fd"));
        } catch {
            continue;
        }

        for (const fd of fds) {
            const match = readLink(join(root, String(pid), "fd", fd))?.match(/^socket:\[(\d+)\]$/);

            if (match) {
                const inode = Number(match[1]);
                const pids = owners.get(inode) ?? new Set<number>();
                pids.add(pid);
                owners.set(inode, pids);
            }
        }
    }

    return owners;
}
