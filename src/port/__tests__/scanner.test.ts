import { describe, expect, it, spyOn } from "bun:test";
import { userInfo } from "node:os";
import * as linux from "@genesiscz/utils/process/linux-proc";
import * as os from "@genesiscz/utils/process/os";
import * as files from "@genesiscz/utils/process/process-files";
import * as processes from "@genesiscz/utils/process/processes";
import * as ps from "@genesiscz/utils/process/ps";
import * as sockets from "@genesiscz/utils/process/sockets";
import {
    getAllProcesses,
    getListeningPorts,
    getPortDetails,
    isLikelyDevProcess,
    STATE_PRIORITY,
    summarizeCommand,
} from "../lib/scanner";
import type { PortProcess } from "../lib/types";

/** The rows `lsof -nP -iTCP -sTCP:LISTEN` prints, one per pid, as the live listing is compared against. */
function parseLsofOutput(output: string, ownPid = process.pid): PortProcess[] {
    const lines = output.trim().split("\n");

    if (lines.length <= 1) {
        return [];
    }

    const byPid = new Map<number, PortProcess>();

    for (let i = 1; i < lines.length; i += 1) {
        const parts = lines[i].trim().split(/\s+/);

        if (parts.length < 9) {
            continue;
        }

        const pid = Number.parseInt(parts[1], 10);

        if (Number.isNaN(pid) || pid === ownPid) {
            continue;
        }

        const name = parts.slice(8).join(" ");
        const stateMatch = name.match(/\((\w+)\)$/);
        const state = stateMatch?.[1] ?? "UNKNOWN";
        const entry: PortProcess = {
            pid,
            command: parts[0],
            user: parts[2],
            state,
            name,
            fd: parts[3],
        };
        const existing = byPid.get(pid);

        if (!existing) {
            byPid.set(pid, entry);
            continue;
        }

        const currentPriority = STATE_PRIORITY[existing.state] ?? 99;
        const newPriority = STATE_PRIORITY[entry.state] ?? 99;

        if (newPriority < currentPriority) {
            byPid.set(pid, entry);
        }
    }

    return Array.from(byPid.values());
}

describe("port owner hydration", () => {
    it("does no process work for an unused port or self-only socket and reads duplicate owners once", () => {
        const platform = spyOn(os, "processPlatform").mockReturnValue("linux");
        const socketRead = spyOn(sockets, "listSockets").mockReturnValue([]);
        const table = spyOn(linux, "listProcProcesses").mockImplementation(() => {
            throw new Error("port scans must not enumerate unrelated processes");
        });
        const read = spyOn(linux, "readProcProcess").mockImplementation((pid) => ({
            pid,
            ppid: 1,
            pgid: pid,
            uid: 1000,
            comm: "node",
            argv: ["node", "server.js"],
            state: "S",
            tty: null,
            startMs: 1000,
            cpuTimeMs: 50,
            rssBytes: 10485760,
            threads: 2,
        }));
        const openFiles = spyOn(files, "listOpenFiles").mockReturnValue([]);
        const cwd = spyOn(ps, "batchCwd").mockReturnValue(new Map());
        const user = spyOn(processes, "userName").mockReturnValue("fixture-user");
        const socket: sockets.SocketEntry = {
            pid: 42,
            protocol: "TCP",
            family: "IPv4",
            address: "127.0.0.1",
            port: 3000,
            remoteAddress: "",
            remotePort: 0,
            state: "LISTEN",
        };

        try {
            expect(getPortDetails(3000)).toEqual([]);
            expect(socketRead).toHaveBeenLastCalledWith({ port: 3000 });
            socketRead.mockReturnValue([{ ...socket, pid: process.pid }]);
            expect(getPortDetails(3000)).toEqual([]);
            expect(read).not.toHaveBeenCalled();
            expect(table).not.toHaveBeenCalled();
            expect(openFiles).not.toHaveBeenCalled();
            expect(cwd).not.toHaveBeenCalled();
            expect(user).not.toHaveBeenCalled();

            socketRead.mockReturnValue([socket, { ...socket, family: "IPv6", address: "[::1]" }]);
            for (const scan of [() => getPortDetails(3000), getListeningPorts]) {
                read.mockClear();
                openFiles.mockClear();
                user.mockClear();
                const rows = scan();
                expect(rows).toHaveLength(1);
                expect(rows[0]).toMatchObject({ pid: 42, command: "node server.js", memory: "10.0 MB" });
                expect(read.mock.calls.map(([pid]) => pid)).toEqual([42]);
                expect(openFiles.mock.calls.map(([pid]) => pid)).toEqual([42]);
                expect(cwd).toHaveBeenLastCalledWith([42]);
                expect(user.mock.calls.every(([uid]) => uid === 1000)).toBe(true);
                expect(table).not.toHaveBeenCalled();
            }
        } finally {
            platform.mockRestore();
            socketRead.mockRestore();
            table.mockRestore();
            read.mockRestore();
            openFiles.mockRestore();
            cwd.mockRestore();
            user.mockRestore();
        }
    });
});

describe("Linux port scan network tables", () => {
    it("reads each network table once however many socket owners there are", () => {
        const platform = spyOn(os, "processPlatform").mockReturnValue("linux");
        const rows = [42, 43].map(
            (pid): sockets.SocketEntry => ({
                pid,
                protocol: "TCP",
                family: "IPv4",
                address: "127.0.0.1",
                port: 3000,
                remoteAddress: "",
                remotePort: 0,
                state: "LISTEN",
            })
        );
        const socketRead = spyOn(sockets, "listSockets").mockReturnValue(rows);
        const read = spyOn(linux, "readProcProcess").mockImplementation((pid) => ({
            pid,
            ppid: 1,
            pgid: pid,
            uid: 1000,
            comm: "node",
            argv: ["node", "server.js"],
            state: "S",
            tty: null,
            startMs: 1000,
            cpuTimeMs: 50,
            rssBytes: 10485760,
            threads: 2,
        }));
        const fds = spyOn(linux, "listProcFds").mockImplementation((pid) => [
            { fd: 3, target: `socket:[${1000 + pid}]`, mode: "u" },
        ]);
        const tcp = spyOn(linux, "readProcTcp").mockReturnValue(
            [42, 43].map((pid) => ({
                localAddress: "127.0.0.1",
                localPort: 3000,
                remoteAddress: "0.0.0.0",
                remotePort: 0,
                state: linux.TCP_LISTEN,
                inode: 1000 + pid,
            }))
        );
        const udp = spyOn(linux, "readProcUdp").mockReturnValue([]);
        const cwdRead = spyOn(linux, "readProcCwd").mockReturnValue(null);
        const exeRead = spyOn(linux, "readProcExe").mockReturnValue(null);
        const cwd = spyOn(ps, "batchCwd").mockReturnValue(new Map());
        const user = spyOn(processes, "userName").mockReturnValue("fixture-user");

        try {
            const found = getPortDetails(3000);

            expect(found.map((row) => row.fd)).toEqual(["3u", "3u"]);
            // Each owner's descriptors are named from the same tables; reading them again per owner is O(owners x sockets).
            expect(tcp.mock.calls.length).toBe(1);
            expect(udp.mock.calls.length).toBe(1);
        } finally {
            for (const spy of [platform, socketRead, read, fds, tcp, udp, cwdRead, exeRead, cwd, user]) {
                spy.mockRestore();
            }
        }
    });
});

describe("Windows port scan batching", () => {
    it("queries CIM once per scan even with multiple sockets for each owner", () => {
        const platform = spyOn(os, "processPlatform").mockReturnValue("win32");
        const cwd = spyOn(ps, "batchCwd").mockReturnValue(new Map());
        const capture = spyOn(ps, "captureSync").mockImplementation((command) => ({
            status: 0,
            stderr: "",
            stdout:
                command === "powershell"
                    ? '[{"ProcessId":42420,"ParentProcessId":4,"Name":"node.exe","CommandLine":"node.exe server.js","WorkingSetSize":10485760},{"ProcessId":42421,"ParentProcessId":4,"Name":"bun.exe","CommandLine":"bun.exe app.ts","WorkingSetSize":20971520}]'
                    : command === "netstat"
                      ? "TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 42420\nTCP [::]:3000 [::]:0 LISTENING 42420\nTCP 127.0.0.1:3000 127.0.0.1:50000 ESTABLISHED 42421\nTCP 0.0.0.0:4000 0.0.0.0:0 LISTENING 42421\n"
                      : "",
        }));
        try {
            expect(getPortDetails(9999)).toEqual([]);
            expect(capture.mock.calls.filter(([command]) => command === "powershell")).toHaveLength(0);
            expect(capture.mock.calls.filter(([command]) => command === "netstat")).toHaveLength(1);
            for (const scan of [() => getPortDetails(3000), getListeningPorts, getAllProcesses]) {
                capture.mockClear();
                const rows = scan();
                expect(rows.map((row) => row.pid)).toEqual([42420, 42421]);
                expect(rows[0].command).toBe("node.exe server.js");
                expect(rows[0].memory).toBe("10.0 MB");
                expect(capture.mock.calls.filter(([command]) => command === "powershell")).toHaveLength(1);
                expect(capture.mock.calls.filter(([command]) => command === "netstat")).toHaveLength(1);
            }
        } finally {
            platform.mockRestore();
            cwd.mockRestore();
            capture.mockRestore();
        }
    });

    it("lists every port one process listens on, and a port once however many sockets hold it", () => {
        const platform = spyOn(os, "processPlatform").mockReturnValue("win32");
        const cwd = spyOn(ps, "batchCwd").mockReturnValue(new Map());
        const capture = spyOn(ps, "captureSync").mockImplementation((command) => ({
            status: 0,
            stderr: "",
            stdout:
                command === "powershell"
                    ? '[{"ProcessId":42420,"ParentProcessId":4,"Name":"node.exe","CommandLine":"node.exe server.js","WorkingSetSize":10485760}]'
                    : command === "netstat"
                      ? "TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 42420\nTCP [::]:3000 [::]:0 LISTENING 42420\nTCP 0.0.0.0:4000 0.0.0.0:0 LISTENING 42420\n"
                      : "",
        }));

        try {
            const rows = getListeningPorts();

            expect(rows.map((row) => [row.pid, row.port])).toEqual([
                [42420, 3000],
                [42420, 4000],
            ]);
            expect(getPortDetails(3000).map((row) => row.pid)).toEqual([42420]);
        } finally {
            platform.mockRestore();
            cwd.mockRestore();
            capture.mockRestore();
        }
    });
});

describe("summarizeCommand", () => {
    it("prefers meaningful script fragments over the executable name", () => {
        const summary = summarizeCommand("node /Users/test/app/server.js --port 3000", "node");

        expect(summary).toBe("server.js 3000");
    });

    it("falls back to the process name when nothing useful is present", () => {
        expect(summarizeCommand("node --watch --inspect", "node")).toBe("node");
    });
});

describe("isLikelyDevProcess", () => {
    it("recognizes common dev runtimes", () => {
        expect(isLikelyDevProcess("node", "node server.js")).toBeTrue();
        expect(isLikelyDevProcess("python3", "python3 manage.py runserver")).toBeTrue();
    });

    it("filters out common desktop apps", () => {
        expect(isLikelyDevProcess("Spotify Helper", "Spotify Helper")).toBeFalse();
    });
});

/** A bun child of ours that listens and prints its port: on 127.0.0.1 and [::1] (one port), or on `::`. */
async function startListener(kind: "loopback-both" | "any-ipv6"): Promise<{ child: Bun.Subprocess; port: number }> {
    const code =
        kind === "loopback-both"
            ? `const net = require("node:net"); const a = net.createServer().listen(0, "127.0.0.1", () => { const port = a.address().port; net.createServer().listen(port, "::1", () => console.log(port)); });`
            : `const net = require("node:net"); const s = net.createServer().listen(0, "::", () => console.log(s.address().port));`;
    const child = Bun.spawn([process.execPath, "-e", code], {
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
    });
    const { value } = await child.stdout.getReader().read();
    return { child, port: Number(new TextDecoder().decode(value).trim()) };
}

describe.skipIf(process.platform !== "darwin")("getListeningPorts on live listeners", () => {
    it("lists each of our listeners once per pid with the cells lsof prints, and not one that exited", async () => {
        const both = await startListener("loopback-both");
        const any = await startListener("any-ipv6");
        const gone = await startListener("any-ipv6");
        gone.child.kill();
        await gone.child.exited;

        try {
            const pids = [both.child.pid, any.child.pid];
            const lsof = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")], {
                env: process.env,
            });
            const expected = parseLsofOutput(lsof.stdout.toString(), -1);
            const ours = getListeningPorts().filter(
                (entry) => pids.includes(entry.pid) || entry.pid === gone.child.pid
            );
            const cells = (entry: { pid: number; user: string; state: string; name: string; fd: string }) => ({
                pid: entry.pid,
                user: entry.user,
                state: entry.state,
                name: entry.name,
                fd: entry.fd,
            });

            const byPid = (a: { pid: number }, b: { pid: number }) => a.pid - b.pid;

            expect(ours.map(cells).sort(byPid)).toEqual(expected.map(cells).sort(byPid));
            expect(ours.map((entry) => entry.port).sort()).toEqual([both.port, any.port].sort());
            expect(["127.0.0.1", "[::1]"].map((address) => `${address}:${both.port} (LISTEN)`)).toContain(
                ours.find((entry) => entry.pid === both.child.pid)?.name ?? ""
            );
            expect(ours.find((entry) => entry.pid === any.child.pid)?.name).toBe(`*:${any.port} (LISTEN)`);
            expect(ours.every((entry) => /^\d+u$/.test(entry.fd) && entry.user === userInfo().username)).toBe(true);
            expect(ours.every((entry) => entry.processName === "bun")).toBe(true);
        } finally {
            both.child.kill();
            any.child.kill();
            await Promise.all([both.child.exited, any.child.exited]);
        }
    });
});
