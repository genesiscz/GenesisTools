import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as processes from "@genesiscz/utils/process/processes";
import * as sockets from "@genesiscz/utils/process/sockets";
import * as resolver from "./resolve";
import { listListeningPorts } from "./scanner";

test("one process snapshot supplies display names and enrichment for every listener in a scan", async () => {
    const owner: processes.ProcessWithUsage = {
        pid: 42420,
        ppid: 1,
        pgid: null,
        uid: null,
        name: "node.exe",
        command: "node.exe server.js",
        tty: null,
        startMs: 1700000000000,
        zombie: false,
        state: "S",
        usage: null,
    };
    const opaque = { ...owner, pid: 42421, name: "opaque-worker", command: null };
    const socket: sockets.SocketEntry = {
        pid: owner.pid,
        protocol: "TCP",
        family: "IPv4",
        address: "127.0.0.1",
        port: 43120,
        remoteAddress: "",
        remotePort: 0,
        state: "LISTEN",
    };
    const scan = spyOn(sockets, "scanSockets").mockReturnValue([
        socket,
        socket,
        { ...socket, family: "IPv6", address: "[::1]" },
        { ...socket, port: 43121 },
        { ...socket, pid: opaque.pid, port: 43122 },
        { ...socket, pid: 42422, port: 43123 },
    ]);
    const snapshot = spyOn(processes, "readProcessesWithUsage").mockReturnValue([owner, opaque]);
    const single = spyOn(processes, "readProcess").mockImplementation((pid) =>
        pid === owner.pid ? owner : pid === opaque.pid ? opaque : null
    );
    const cwd = spyOn(resolver, "batchCwds").mockResolvedValue(new Map());

    try {
        const result = await listListeningPorts();
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(snapshot).toHaveBeenLastCalledWith([42420, 42421, 42422]);
        expect(single).not.toHaveBeenCalled();
        expect(result.lsofAvailable).toBe(true);
        expect(result.ports).toHaveLength(5);
        for (const port of result.ports.filter((port) => port.pid === owner.pid)) {
            expect(port).toMatchObject({
                command: "node.exe",
                fullCommand: "node.exe server.js",
                startedAt: "2023-11-14T22:13:20.000Z",
            });
        }
        expect(result.ports.find((port) => port.pid === opaque.pid)?.command).toBe("opaque-worker");
        expect(result.ports.find((port) => port.pid === 42422)?.command).toBe("unknown");

        // A supplied empty snapshot is authoritative: enrichment must not retry each missing PID.
        snapshot.mockReturnValue([]);
        const unavailableMeta = await listListeningPorts();
        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(single).not.toHaveBeenCalled();
        expect(unavailableMeta.lsofAvailable).toBe(true);
        expect(unavailableMeta.ports).toHaveLength(5);
        expect(unavailableMeta.ports.every((port) => port.command === "unknown")).toBe(true);

        scan.mockReturnValue(null);
        expect(await listListeningPorts()).toMatchObject({ lsofAvailable: false, ports: [] });
        scan.mockReturnValue([]);
        expect(await listListeningPorts()).toMatchObject({ lsofAvailable: true, ports: [] });
        expect(snapshot).toHaveBeenCalledTimes(2);
    } finally {
        scan.mockRestore();
        snapshot.mockRestore();
        single.mockRestore();
        cwd.mockRestore();
    }
});

test("a failed socket scan is unavailable, not an empty successful listing", async () => {
    const scan = spyOn(sockets, "scanSockets").mockReturnValue(null);
    try {
        expect(await listListeningPorts()).toMatchObject({ lsofAvailable: false, ports: [] });
        expect(scan).toHaveBeenCalledTimes(1);
    } finally {
        scan.mockRestore();
    }
});

describe.skipIf(process.platform !== "darwin")("listListeningPorts on a live listener", () => {
    test("lists our IPv4 and IPv6 sockets on one port with the command, argv and cwd of the process", async () => {
        const marker = `gt-ports-probe-${crypto.randomUUID()}`;
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "ports-probe-")));
        const code = `const net = require("node:net"); const a = net.createServer().listen(0, "127.0.0.1", () => { const port = a.address().port; net.createServer().listen(port, "::1", () => console.log(port)); });`;
        const child = Bun.spawn([process.execPath, "-e", code, marker], {
            cwd: dir,
            env: process.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
        });
        const { value } = await child.stdout.getReader().read();
        const port = Number(new TextDecoder().decode(value).trim());

        try {
            const spawn = spyOn(Bun, "spawn");
            let result: Awaited<ReturnType<typeof listListeningPorts>>;
            let spawned: string[] = [];

            try {
                result = await listListeningPorts();
                spawned = spawn.mock.calls.map((call) => (Array.isArray(call[0]) ? String(call[0][0]) : "?"));
            } finally {
                spawn.mockRestore();
            }

            const ours = result.ports.filter((entry) => entry.pid === child.pid);

            // The listeners and their working directories come from libproc; only the argv batch still runs ps.
            expect(spawned.filter((command) => command.endsWith("lsof"))).toEqual([]);
            expect(result.lsofAvailable).toBe(true);
            expect(ours.map((entry) => [entry.port, entry.proto, entry.address])).toEqual([
                [port, "tcp4", "127.0.0.1"],
                [port, "tcp6", "[::1]"],
            ]);

            for (const entry of ours) {
                expect(entry.fullCommand).toContain(marker);
                expect(entry.cwd).toBe(dir);
            }
        } finally {
            child.kill();
            await child.exited;
        }
    });
});
