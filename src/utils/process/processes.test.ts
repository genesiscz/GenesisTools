import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
    constants,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
    listProcProcesses,
    parseNulList,
    parseProcNetTcp,
    parseProcStat,
    parseProcUid,
    readProcEnviron,
    readProcExe,
    socketInodeOwners,
    TCP_LISTEN,
    ttyName,
} from "./linux-proc";
import { countOpenFiles, executableInode, listOpenFiles } from "./process-files";
import {
    ancestry,
    childPids,
    findProcesses,
    formatLstart,
    listProcesses,
    listProcessesWithUsage,
    parseFallbackPsTable,
    parsePasswd,
    readExecutablePath,
    readProcess,
    readProcessEnvironment,
    readProcessUsages,
    userName,
} from "./processes";
import {
    canReadSockets,
    listEstablishedTcp,
    listeningPidsOnPort,
    listListeningTcp,
    listSockets,
    parseLsofSockets,
} from "./sockets";
import { parseCimDate, parseCimProcessJson, parseNetstatTcp } from "./windows-cim";

const PROCESS_TOOLS = /(^|\/)(ps|lsof|pgrep)$/;

/**
 * The programs `run` starts. Every `node:child_process` entry point funnels into `Bun.spawn` or `Bun.spawnSync` on
 * Bun, so the two spies see every spawn but `Bun.$`. The calls are copied BEFORE the restore: `mockRestore()` clears
 * `mock.calls`, so reading them afterwards always finds none.
 */
function spawnedPrograms(run: () => void): string[] {
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    let calls: unknown[][] = [];

    try {
        run();
    } finally {
        calls = [...spawn.mock.calls, ...spawnSync.mock.calls];
        spawn.mockRestore();
        spawnSync.mockRestore();
    }

    return calls.map(([first]) =>
        Array.isArray(first) ? String(first[0]) : String((first as { cmd?: string[] }).cmd?.[0])
    );
}

describe("linux /proc parsers", () => {
    test("stat keeps a comm with spaces and parentheses, and reads fields after the last parenthesis", () => {
        const stat = parseProcStat(
            "1234 (my (weird) proc) S 1 1234 1234 34816 1234 4194304 100 0 0 0 250 75 0 0 20 0 3 0 98765 123456789 2560 1"
        );
        expect(stat).toMatchObject({ pid: 1234, comm: "my (weird) proc", state: "S", ppid: 1, ttyNr: 34816 });
        expect(stat).toMatchObject({ utimeTicks: 250, stimeTicks: 75, threads: 3, startTicks: 98765, rssPages: 2560 });
        expect(parseProcStat("no parenthesis")).toBeNull();
    });

    test("terminal numbers print as ps prints them", () => {
        expect(ttyName(34816)).toBe("pts/0");
        expect(ttyName((137 << 8) | 4)).toBe("pts/260");
        expect(ttyName(1025)).toBe("tty1");
        expect(ttyName(0)).toBeNull();
    });

    test("net/tcp rows decode IPv4, IPv6 and IPv4-mapped addresses", () => {
        const v4 = parseProcNetTcp(
            "  sl  local_address rem_address   st\n   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1"
        );
        expect(v4).toEqual([
            {
                localAddress: "127.0.0.1",
                localPort: 3306,
                remoteAddress: "0.0.0.0",
                remotePort: 0,
                state: TCP_LISTEN,
                inode: 33333,
            },
        ]);
        const v6 = parseProcNetTcp(
            "header\n   0: 00000000000000000000000001000000:0016 00000000000000000000000000000000:0000 0A 0:0 0:0 0 0 0 12345 1\n" +
                "   1: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 01 0:0 0:0 0 0 0 22222 1"
        );
        expect(v6.map((row) => `${row.localAddress}:${row.localPort}`)).toEqual(["::1:22", "::ffff:127.0.0.1:8080"]);
    });

    test("status uid and NUL lists", () => {
        expect(parseProcUid("Name:\tbash\nUid:\t1000\t1000\t1000\t1000\n")).toBe(1000);
        expect(parseNulList("bun\0run\0x.ts\0")).toEqual(["bun", "run", "x.ts"]);
        expect(parseNulList("")).toEqual([]);
    });

    describe("a fixture /proc tree", () => {
        let root: string;

        beforeAll(() => {
            root = mkdtempSync(join(tmpdir(), "proc-fixture-"));
            writeFileSync(join(root, "stat"), "cpu 1 2 3\nbtime 1700000000\n");
            const pid = join(root, "42");
            mkdirSync(join(pid, "fd"), { recursive: true });
            writeFileSync(join(pid, "stat"), "42 (node) S 7 42 42 34817 42 0 0 0 0 0 100 50 0 0 20 0 9 0 500 0 1000 1");
            writeFileSync(join(pid, "status"), "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n");
            writeFileSync(join(pid, "cmdline"), `${["node", "server.js", "--port", "3000"].join("\0")}\0`);
            writeFileSync(join(pid, "environ"), "HOME=/home/alice\0LANG=C\0");
            symlinkSync("/usr/bin/node", join(pid, "exe"));
            symlinkSync("socket:[777]", join(pid, "fd", "3"));
            symlinkSync("/dev/null", join(pid, "fd", "0"));
        });

        test("reads a process, its environment, executable and socket inodes", () => {
            expect(listProcProcesses(root)).toEqual([
                {
                    pid: 42,
                    ppid: 7,
                    pgid: 42,
                    uid: 1000,
                    comm: "node",
                    argv: ["node", "server.js", "--port", "3000"],
                    state: "S",
                    tty: "pts/1",
                    startMs: 1700000000 * 1000 + 5000,
                    cpuTimeMs: 1500,
                    rssBytes: 1000 * 4096,
                    threads: 9,
                },
            ]);
            expect(readProcEnviron(42, root)).toEqual(["HOME=/home/alice", "LANG=C"]);
            expect(readProcExe(42, root)).toBe("/usr/bin/node");
            expect(socketInodeOwners(root)).toEqual(new Map([[777, 42]]));
            expect(readProcEnviron(43, root)).toBeNull();
        });
    });
});

describe("windows CIM and netstat parsers", () => {
    test("one object and an array, both date encodings, a missing command line", () => {
        const single = parseCimProcessJson(
            '{"ProcessId":4242,"ParentProcessId":4,"Name":"chrome.exe","CommandLine":"\\"C:\\\\chrome.exe\\" --flag","ExecutablePath":"C:\\\\chrome.exe","CreationDate":"/Date(1700000000000)/","WorkingSetSize":"104857600","KernelModeTime":"20000000","UserModeTime":"30000000","ThreadCount":40,"HandleCount":900}'
        );
        expect(single).toEqual([
            {
                pid: 4242,
                ppid: 4,
                name: "chrome.exe",
                command: '"C:\\chrome.exe" --flag',
                executable: "C:\\chrome.exe",
                startMs: 1700000000000,
                rssBytes: 104857600,
                cpuTimeMs: 5000,
                threads: 40,
                handles: 900,
            },
        ]);
        const many = parseCimProcessJson(
            '[{"ProcessId":0,"Name":"System Idle Process"},{"ProcessId":8,"CommandLine":null}]'
        );
        expect(many.map((p) => [p.pid, p.command])).toEqual([
            [0, null],
            [8, null],
        ]);
        expect(parseCimDate("2026-10-14T01:00:00.000+02:00")).toBe(Date.parse("2026-10-13T23:00:00Z"));
        expect(parseCimProcessJson("not json")).toEqual([]);
    });

    test("netstat rows for IPv4 and bracketed IPv6", () => {
        const rows = parseNetstatTcp(
            "Active Connections\n\n  Proto  Local Address  Foreign Address  State  PID\n" +
                "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1012\n" +
                "  TCP    [::]:445       [::]:0       LISTENING    4\n" +
                "  TCP    127.0.0.1:5000 127.0.0.1:62000 ESTABLISHED 4242\n" +
                "  UDP    0.0.0.0:53     *:*                         2000\n"
        );
        expect(rows.map((r) => [r.protocol, r.localAddress, r.localPort, r.state, r.pid])).toEqual([
            ["TCP", "0.0.0.0", 135, "LISTENING", 1012],
            ["TCP", "::", 445, "LISTENING", 4],
            ["TCP", "127.0.0.1", 5000, "ESTABLISHED", 4242],
            ["UDP", "0.0.0.0", 53, "", 2000],
        ]);
    });
});

describe("the ps and lsof fallbacks", () => {
    test("a ps table with a spaced command name and no terminal", () => {
        const [entry] = parseFallbackPsTable(
            "  4242     1  4242   501 ??       S    Tue Oct 13 15:32:57 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n"
        );
        expect(entry).toMatchObject({ pid: 4242, ppid: 1, pgid: 4242, uid: 501, name: "Google Chrome", tty: null });
        expect(entry).toMatchObject({ zombie: false, state: "S" });
        expect(entry.startMs).toBe(Date.parse("Tue Oct 13 15:32:57 2026"));
    });

    test("lsof listening and established rows", () => {
        const rows = parseLsofSockets(
            "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n" +
                "node 4242 alice 20u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)\n" +
                "node 4242 alice 21u IPv6 0x2 0t0 TCP [::1]:51000->[::1]:3000 (ESTABLISHED)\n" +
                "mDNSResp 77 alice 8u IPv4 0x3 0t0 UDP *:5353\n"
        );
        const tcp = { pid: 4242, protocol: "TCP" as const };
        expect(rows).toEqual([
            {
                ...tcp,
                family: "IPv4",
                address: "127.0.0.1",
                port: 3000,
                remoteAddress: "",
                remotePort: 0,
                state: "LISTEN",
            },
            {
                ...tcp,
                family: "IPv6",
                address: "[::1]",
                port: 51000,
                remoteAddress: "[::1]",
                remotePort: 3000,
                state: "ESTABLISHED",
            },
            {
                pid: 77,
                protocol: "UDP",
                family: "IPv4",
                address: "*",
                port: 5353,
                remoteAddress: "",
                remotePort: 0,
                state: null,
            },
        ]);
    });

    test("passwd names and ps start times", () => {
        expect(parsePasswd("root:x:0:0::/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/zsh\n# comment\n")).toEqual(
            new Map([
                [0, "root"],
                [1000, "alice"],
            ])
        );
        expect(formatLstart(Date.UTC(2026, 9, 6, 23, 40, 5), "Europe/Prague")).toBe("Wed Oct  7 01:40:05 2026");
        expect(formatLstart(Date.UTC(2026, 0, 5, 9, 0, 0), "UTC")).toBe("Mon Jan  5 09:00:00 2026");
    });
});

describe.skipIf(process.platform === "win32")("the readers against this machine", () => {
    let server: ReturnType<typeof Bun.serve>;
    let client: Awaited<ReturnType<typeof Bun.connect>>;

    beforeAll(async () => {
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
        client = await Bun.connect({ hostname: "127.0.0.1", port: server.port as number, socket: { data() {} } });
    });

    afterAll(() => {
        client.end();
        server.stop(true);
    });

    test("never start ps, lsof or pgrep", () => {
        const programs = spawnedPrograms(() => {
            listProcesses();
            readProcess(process.pid);
            childPids(process.ppid);
            findProcesses({ name: "launchd", command: "bun" });
            readExecutablePath(process.pid);
            readProcessEnvironment(process.pid);
            readProcessUsages([process.pid]);
            countOpenFiles(process.pid);
            listListeningTcp();
            listEstablishedTcp();
            ancestry(process.pid, 3);
        });

        expect(programs.filter((program) => PROCESS_TOOLS.test(program))).toEqual([]);
    });

    test("this process: its parent, command line, executable, environment, usage and descriptors", () => {
        const me = readProcess(process.pid);
        expect(me?.ppid).toBe(process.ppid);
        // A live process: macOS cannot tell R from S at the process level, so it reads S; Linux may read R.
        expect(["R", "S"]).toContain(me?.state ?? "");
        expect(me?.pgid).toBeGreaterThan(0);
        expect(me?.command).toContain(process.argv0.split("/").pop() ?? "bun");
        expect(childPids(process.ppid)).toContain(process.pid);
        expect(ancestry(process.pid, 2).map((entry) => entry.pid)).toEqual([process.pid, process.ppid]);
        expect(realpathSync(readExecutablePath(process.pid) ?? "")).toBe(realpathSync(process.execPath));
        expect(readProcessEnvironment(process.pid)?.PATH).toBeDefined();
        const usage = readProcessUsages([process.pid]).get(process.pid);
        expect(usage?.rssBytes).toBeGreaterThan(0);
        expect(usage?.threads ?? 1).toBeGreaterThan(0);
        // This test is on a CPU while it reads itself.
        expect(usage?.running).toBe(true);
        expect(countOpenFiles(process.pid)).toBeGreaterThanOrEqual(3);
        expect(userName(process.getuid?.() ?? -1)).toBe(userInfo().username);
        expect(userName(0)).toBe("root");
    });

    test("the start time prints exactly as ps -o lstart= prints it", () => {
        const fromPs = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.ppid)], { env: process.env })
            .stdout.toString()
            .trim();
        const startMs = readProcess(process.ppid)?.startMs ?? 0;
        expect(formatLstart(startMs).replace(/\s+/g, " ")).toBe(fromPs.replace(/\s+/g, " "));
        expect(formatLstart(startMs).length).toBe(fromPs.length);
    });

    test("open files: the working directory, the executable, and a server socket", () => {
        const files = listOpenFiles(process.pid) ?? [];
        expect(files.find((file) => file.fd === "cwd")?.name).toBe(realpathSync(process.cwd()));
        expect(files.some((file) => file.fd === "txt")).toBe(true);
        expect(files.some((file) => file.name.includes(`:${server.port} (LISTEN)`))).toBe(true);
    });

    test("a moved executable keeps its inode, as lsof -d txt reports it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "moved-exe-"));
        const exe = join(dir, "first-name");
        const darwin = process.platform === "darwin";
        copyFileSync(darwin ? process.execPath : "/bin/sleep", exe, constants.COPYFILE_FICLONE);
        const child = Bun.spawn([exe, ...(darwin ? ["-e", "setTimeout(() => {}, 30000)"] : ["30"])], {
            stdout: "ignore",
            stderr: "ignore",
            env: process.env,
        });

        try {
            const inode = statSync(exe).ino;
            renameSync(exe, join(dir, "moved-name"));
            expect(executableInode(child.pid)).toBe(inode);
        } finally {
            child.kill();
            await child.exited;
        }
    });

    test("the whole table agrees with ps on who is whose parent", () => {
        const fromPs = new Map(
            Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { env: process.env })
                .stdout.toString()
                .trim()
                .split("\n")
                .map((line) => line.trim().split(/\s+/).map(Number) as [number, number])
        );
        const ours = listProcesses({ commands: false });
        const common = ours.filter((entry) => fromPs.has(entry.pid));
        // Processes start and end between the two reads; the survivors must agree.
        expect(common.length).toBeGreaterThan(ours.length * 0.9);
        expect(common.filter((entry) => fromPs.get(entry.pid) !== entry.ppid)).toEqual([]);
    });

    test("with usage: this process has its command and usage, and the table agrees with ps on groups", () => {
        const me = listProcessesWithUsage().find((entry) => entry.pid === process.pid);
        expect(me?.command).toContain("bun");
        expect(me?.usage?.rssBytes).toBeGreaterThan(0);
        const fromPs = Number(
            Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)], { env: process.env }).stdout.toString()
        );
        expect(me?.pgid).toBe(fromPs);
    });

    test.skipIf(process.platform !== "darwin")("other users' rows cost exactly one ps, however many there are", () => {
        let rows: ReturnType<typeof listProcessesWithUsage> = [];
        const programs = spawnedPrograms(() => {
            rows = listProcessesWithUsage({ otherUsers: true });
        });

        expect(programs.filter((program) => PROCESS_TOOLS.test(program))).toEqual(["ps"]);
        // launchd is root's: its usage comes from that one ps.
        expect(rows.find((row) => row.pid === 1)?.usage?.rssBytes).toBeGreaterThan(0);
    });

    test("sockets are readable here, so an empty list means none", () => {
        expect(canReadSockets()).toBe(true);
    });

    test("a server and its client socket in this process", () => {
        const port = server.port as number;
        expect(listListeningTcp().some((socket) => socket.pid === process.pid && socket.port === port)).toBe(true);
        expect(listeningPidsOnPort(port)).toEqual([process.pid]);
        expect(
            listSockets({ port })
                .map((socket) => [socket.pid, socket.state])
                .sort()
        ).toContainEqual([process.pid, "LISTEN"]);
        expect(
            listEstablishedTcp().some(
                (connection) => connection.pid === process.pid && connection.remotePort === port && connection.port > 0
            )
        ).toBe(true);
    });

    test("a name search leaves out this process and its ancestors, as pgrep does, unless asked", () => {
        const name = readProcess(process.pid)?.name ?? "";
        expect(findProcesses({ name }).map((entry) => entry.pid)).not.toContain(process.pid);
        expect(findProcesses({ name, includeAncestors: true }).map((entry) => entry.pid)).toContain(process.pid);
        expect(findProcesses({ command: process.argv[1] ?? "bun" }).map((entry) => entry.pid)).not.toContain(
            process.ppid
        );
        expect(findProcesses({ name, command: "no such command line anywhere", includeAncestors: true })).toEqual([]);
    });

    test("a name the kernel cut matches only in full", async () => {
        // A real executable with a 25-byte name: the kernel name comes from the file, not from a symlink or a script.
        // macOS runs a copy of bun (an APFS clone, instant); a copied system binary is refused there.
        const dir = mkdtempSync(join(tmpdir(), "long-name-"));
        const exe = join(dir, "genesis-long-process-name");
        const darwin = process.platform === "darwin";
        copyFileSync(darwin ? process.execPath : "/bin/sleep", exe, constants.COPYFILE_FICLONE);
        const child = Bun.spawn([exe, ...(darwin ? ["-e", "setTimeout(() => {}, 30000)"] : ["30"])], {
            stdout: "ignore",
            stderr: "ignore",
            env: process.env,
        });

        try {
            // The kernel keeps 16 bytes on macOS and 15 on Linux; neither cut is the process's name.
            expect(findProcesses({ name: "genesis-long-pro" }).map((entry) => entry.pid)).not.toContain(child.pid);
            expect(findProcesses({ name: "genesis-long-pr" }).map((entry) => entry.pid)).not.toContain(child.pid);
            expect(findProcesses({ name: "genesis-long-process-name" }).map((entry) => entry.pid)).toEqual([child.pid]);
        } finally {
            child.kill();
            await child.exited;
        }
    });
});
