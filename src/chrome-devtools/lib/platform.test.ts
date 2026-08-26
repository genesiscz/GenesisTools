import { describe, expect, test } from "bun:test";
import {
    artifactPath,
    parseCimProcesses,
    parseCimSample,
    parseLsofListeners,
    parseNetstatListeners,
    parsePsProcesses,
    parsePsSample,
    terminatePid,
    tmpRoot,
} from "./platform.ts";

describe("tmpRoot / artifactPath", () => {
    test("POSIX keeps the /tmp contract; win32 uses the OS temp dir", () => {
        expect(tmpRoot("darwin")).toBe("/tmp");
        expect(tmpRoot("linux")).toBe("/tmp");
        expect(tmpRoot("win32")).not.toBe("/tmp");
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
