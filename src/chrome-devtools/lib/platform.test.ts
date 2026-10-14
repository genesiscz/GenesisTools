import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    artifactPath,
    listListeningTcpPorts,
    parseCimProcesses,
    parseCimSample,
    parseLsofListeners,
    parseNetstatListeners,
    parsePsProcesses,
    parsePsSample,
    processArguments,
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

describe("parsePsProcesses", () => {
    test("parses pid/ppid/command triples and skips garbage lines", () => {
        const entries = parsePsProcesses("    1 0 /sbin/launchd\n  842 1 /usr/bin/something --flag x\nnot a line\n");
        expect(entries).toEqual([
            { pid: 1, ppid: 0, command: "/sbin/launchd" },
            { pid: 842, ppid: 1, command: "/usr/bin/something --flag x" },
        ]);
    });
});

describe("parseCimProcesses", () => {
    test("parses both a JSON array and a single object, tolerating null CommandLine", () => {
        const array = parseCimProcesses(
            '[{"ProcessId":4321,"ParentProcessId":1,"CommandLine":"chrome.exe --type=browser","Name":"chrome.exe"},{"ProcessId":5,"ParentProcessId":4321,"CommandLine":null,"Name":"svchost.exe"}]'
        );
        expect(array).toEqual([
            { pid: 4321, ppid: 1, command: "chrome.exe --type=browser" },
            { pid: 5, ppid: 4321, command: "svchost.exe" },
        ]);

        const single = parseCimProcesses('{"ProcessId":9,"ParentProcessId":2,"CommandLine":"x","Name":"x.exe"}');
        expect(single).toHaveLength(1);
        expect(parseCimProcesses("not json")).toEqual([]);
    });
});

describe("listener parsers", () => {
    test("lsof LISTEN lines yield port + pid", () => {
        const out = parseLsofListeners(
            "Brave   1030 Martin  43u  IPv4 0x0      0t0  TCP 127.0.0.1:9333 (LISTEN)\nbun     1823 Martin  10u  IPv4 0x0  0t0  TCP *:9876 (LISTEN)\n"
        );
        expect(out).toEqual([
            { port: 9333, pid: 1030 },
            { port: 9876, pid: 1823 },
        ]);
    });

    test("netstat LISTENING lines yield port + pid", () => {
        const out = parseNetstatListeners(
            "  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4321\n  TCP    [::]:445               [::]:0                 LISTENING       4\n  UDP    0.0.0.0:5353           *:*                                    999\n"
        );
        expect(out).toEqual([
            { port: 9222, pid: 4321 },
            { port: 445, pid: 4 },
        ]);
    });
});

describe("process samples", () => {
    test("ps sample line parses into cpu/rss/times", () => {
        const sample = parsePsSample(42, "  1.5 113312 0:03.15 04:32 R bun record --port 9222");
        expect(sample).toEqual({
            pid: 42,
            cpuPercent: 1.5,
            rssKb: 113312,
            cpuTime: "0:03.15",
            elapsed: "04:32",
            state: "R",
            command: "bun record --port 9222",
        });
    });

    test("CIM sample converts 100ns ticks to cpu time and bytes to KB; %CPU is null", () => {
        const sample = parseCimSample(
            7,
            '{"WorkingSetSize":104857600,"KernelModeTime":150000000,"UserModeTime":450000000,"CommandLine":"chrome.exe","Name":"chrome.exe"}'
        );
        expect(sample?.rssKb).toBe(102400);
        expect(sample?.cpuTime).toBe("1:00.00");
        expect(sample?.cpuPercent).toBeNull();
    });
});

describe("terminatePid", () => {
    test("POSIX sends kill; win32 sends taskkill /PID without /F", () => {
        const calls: string[][] = [];
        const exec = (argv: string[]) => {
            calls.push(argv);

            return { exitCode: 0, stdout: "", stderr: "" };
        };

        terminatePid(42, exec, "linux");
        terminatePid(42, exec, "win32");
        expect(calls).toEqual([
            ["kill", "42"],
            ["taskkill", "/PID", "42"],
        ]);
    });
});
