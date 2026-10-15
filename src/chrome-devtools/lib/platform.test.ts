import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { SafeJSON } from "@genesiscz/utils/json";
import * as processes from "@genesiscz/utils/process/processes";
import { parseLsofListeners, processFixture } from "./__tests__/process-fixture";
import {
    artifactPath,
    listListeningTcpPorts,
    processArguments,
    processReaderFor,
    terminatePid,
    tmpRoot,
} from "./platform.ts";

describe.skipIf(process.platform !== "darwin")("listListeningTcpPorts on live listeners", () => {
    test("answers one row per listening socket, as lsof lists them, IPv4 and IPv6 on one port included", async () => {
        // 127.0.0.1 and [::1] on the same port in one process: two sockets, two rows.
        const code = `const net = require("node:net"); const a = net.createServer().listen(0, "127.0.0.1", () => { const port = a.address().port; net.createServer().listen(port, "::1", () => console.log(port)); });`;
        const child = Bun.spawn([process.execPath, "-e", code], {
            env: process.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
        });
        const { value } = await child.stdout.getReader().read();
        const port = Number(new TextDecoder().decode(value).trim());

        try {
            const lsof = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(child.pid)], {
                env: process.env,
            });
            const spawnSync = spyOn(Bun, "spawnSync");
            const listed = listListeningTcpPorts();
            const spawned = spawnSync.mock.calls.length;
            spawnSync.mockRestore();
            const ours = listed.filter((listener) => listener.pid === child.pid);

            // From libproc, not from an lsof child.
            expect(spawned).toBe(0);
            expect(ours).toEqual(parseLsofListeners(lsof.stdout.toString()));
            expect(ours).toEqual([
                { port, pid: child.pid },
                { port, pid: child.pid },
            ]);
        } finally {
            child.kill();
            await child.exited;
        }
    });
});

describe("processArguments", () => {
    test("Linux reads NUL boundaries, preserving spaces inside arguments, and refuses failed reads", () => {
        const args = ["/usr/bin/chromium", "https://example.test/?q= --user-data-dir=/tmp/fixture"];
        const calls: string[][] = [];
        expect(
            processArguments(
                42,
                (argv) => {
                    calls.push(argv);
                    return { exitCode: 0, stdout: `${args.join("\0")}\0`, stderr: "" };
                },
                "linux"
            )
        ).toEqual(args);
        expect(calls).toEqual([["cat", "/proc/42/cmdline"]]);
        for (const result of [
            { exitCode: 1, stdout: "", stderr: "denied" },
            { exitCode: 0, stdout: args.join(" "), stderr: "" },
        ]) {
            expect(processArguments(42, () => result, "linux")).toBeNull();
        }
    });

    test("Windows delegates boundary decoding to CommandLineToArgvW and refuses invalid results", () => {
        const args = ["chrome.exe", "https://example.test/?q= --user-data-dir=/tmp/fixture"];
        expect(
            processArguments(
                42,
                (argv) => {
                    expect(argv[0]).toBe("powershell");
                    expect(argv[3]).toContain("CommandLineToArgvW");
                    return { exitCode: 0, stdout: SafeJSON.stringify(args), stderr: "" };
                },
                "win32"
            )
        ).toEqual(args);
        for (const stdout of ["null", '["chrome.exe", 1]', "not json"]) {
            expect(processArguments(42, () => ({ exitCode: 0, stdout, stderr: "" }), "win32")).toBeNull();
        }
        expect(processArguments(42, () => ({ exitCode: 1, stdout: "[]", stderr: "denied" }), "win32")).toBeNull();
    });

    test.skipIf(process.platform !== "darwin")("macOS reads a fixture child's actual argv boundaries", async () => {
        const url = "https://example.test/?q= --user-data-dir=/tmp/fixture";
        const child = Bun.spawn([process.execPath, "-e", "console.log('ready'); await Bun.stdin.text();", "--", url], {
            env: process.env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
        });
        try {
            await child.stdout.getReader().read();
            const args = processArguments(child.pid);
            expect(args).toContain(url);
            expect(args?.some((arg) => arg.startsWith("--user-data-dir"))).toBe(false);
        } finally {
            child.stdin.end();
            await child.exited;
        }
        expect(processArguments(child.pid)).toBeNull();
    });
});

describe("the default process sample", () => {
    const exec = Object.assign(() => ({ stdout: "", stderr: "", exitCode: 0 }), {});

    test("comes from one process-layer snapshot, because on Windows each call is a PowerShell start", () => {
        const pid = 31337;
        const one = spyOn(processes, "readProcessesWithUsage").mockReturnValue([
            {
                pid,
                ppid: 1,
                pgid: pid,
                uid: null,
                name: "recorder",
                command: "recorder --capture",
                tty: null,
                startMs: Date.now() - 90_061_000,
                zombie: false,
                state: "R",
                usage: { pid, rssBytes: 2048 * 1024, cpuTimeMs: 61_500, threads: 4, running: null },
                cpuPercent: 12.5,
            },
        ]);
        const alone = [
            spyOn(processes, "readProcess"),
            spyOn(processes, "readProcessUsages"),
            spyOn(processes, "readCpuPercents"),
        ];

        try {
            const sample = processReaderFor(exec, "darwin").sample(pid);

            expect(sample).toMatchObject({
                pid,
                cpuPercent: 12.5,
                rssKb: 2048,
                state: "R",
                command: "recorder --capture",
            });
            expect(sample?.elapsed).toMatch(/^1-01:/);
            expect(one.mock.calls.length).toBe(1);
            expect(one.mock.calls[0]?.[0]).toEqual([pid]);
            expect(alone.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
        } finally {
            one.mockRestore();

            for (const spy of alone) {
                spy.mockRestore();
            }
        }
    });

    test("a process that has gone gives no sample", () => {
        const one = spyOn(processes, "readProcessesWithUsage").mockReturnValue([]);

        try {
            expect(processReaderFor(exec, "darwin").sample(31338)).toBeNull();
        } finally {
            one.mockRestore();
        }
    });
});

describe("tmpRoot / artifactPath", () => {
    test("POSIX keeps the /tmp contract; win32 uses the OS temp dir", () => {
        expect(tmpRoot("darwin")).toBe("/tmp");
        expect(tmpRoot("linux")).toBe("/tmp");
        // Asserted against `tmpdir()` itself rather than as "not /tmp": on a Linux
        // HOST the OS temp dir IS /tmp, so the negative form was really testing
        // where the test happened to run.
        expect(tmpRoot("win32")).toBe(tmpdir());
        expect(artifactPath("cdp.har", "linux")).toBe("/tmp/cdp.har");
    });
});

describe("terminatePid", () => {
    test("POSIX sends kill; win32 sends taskkill /PID without /F", () => {
        const calls: string[][] = [];
        const exec = processFixture((argv: string[]) => {
            calls.push(argv);

            return { exitCode: 0, stdout: "", stderr: "" };
        });

        terminatePid(42, exec, "linux");
        terminatePid(42, exec, "win32");
        expect(calls).toEqual([
            ["kill", "42"],
            ["taskkill", "/PID", "42"],
        ]);
    });
});
