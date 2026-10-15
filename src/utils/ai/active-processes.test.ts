import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kernel from "@genesiscz/utils/process/libproc-table";
import * as processes from "@genesiscz/utils/process/processes";
import { withTimeZoneAsync } from "@genesiscz/utils/test/timezone";
import { listActiveAgentProcesses, parseLsofCwd, parsePsLine } from "./active-processes";

/**
 * The `ps` and `lsof` readers behind `tools <agent> who`. A row that half-parses is worse than
 * one that is skipped: it becomes a table line with a wrong pid or a wrong directory, and
 * `who` is what a person consults before killing something.
 */

describe("parsePsLine", () => {
    test("reads the pid, tty, start time and argv out of one BSD ps row", () => {
        const row = parsePsLine(
            "  4242   111 s045  Wed Aug 26 18:13:02 2026   0:03.21 /opt/homebrew/bin/codex --remote x"
        );

        expect(row).toMatchObject({ pid: 4242, ppid: 111, tty: "s045", cpuTime: "0:03.21" });
        expect(row?.args).toBe("/opt/homebrew/bin/codex --remote x");
        expect(new Date(row?.startedAt ?? 0).getFullYear()).toBe(2026);
    });

    test("a header line or a truncated row is skipped, never half-parsed", () => {
        expect(parsePsLine("  PID  PPID TTY  STARTED  TIME COMMAND")).toBeNull();
        expect(parsePsLine("")).toBeNull();
    });
});

describe("parseLsofCwd", () => {
    test("pairs each pid with the directory that follows it", () => {
        expect([...parseLsofCwd("p4242\nn/repo\np99\nn/tmp/work\n").entries()]).toEqual([
            [4242, "/repo"],
            [99, "/tmp/work"],
        ]);
    });

    test("a name with no pid before it is dropped rather than attributed to another process", () => {
        const paths = parseLsofCwd("n/orphan\np7\nn/kept");

        expect(paths.get(7)).toBe("/kept");
        expect(paths.size).toBe(1);
    });
});

describe.skipIf(process.platform !== "darwin")("listActiveAgentProcesses on live processes", () => {
    test("finds our marked children with tty, start, CPU time, argv, account and cwd", async () => {
        const marker = `gt-who-probe-${crypto.randomUUID()}`;
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "who-probe-")));
        const code = "setTimeout(() => {}, 30000)";
        const spawnProbe = (account: string | null) => {
            const env = { ...process.env };
            delete env.TOOLS_CLAUDE_ACCOUNT;

            if (account !== null) {
                env.TOOLS_CLAUDE_ACCOUNT = account;
            }

            return Bun.spawn([process.execPath, "-e", code, marker], {
                cwd: dir,
                env,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            });
        };
        const started = Date.now();
        const probes = [spawnProbe(null), spawnProbe("work laptop"), spawnProbe("proxy:openai")];

        try {
            let rows: Awaited<ReturnType<typeof listActiveAgentProcesses>> = [];
            // `bun test` runs JS in UTC but a `ps` child prints the Mac's own zone (TZ never reaches it), so the JS
            // side is put in that zone too, as it is when `tools claude who` runs outside a test.
            const macZone = readlinkSync("/etc/localtime").split("zoneinfo/")[1] ?? "UTC";
            await withTimeZoneAsync(macZone, async () => {
                rows = await listActiveAgentProcesses({
                    alias: "claude",
                    classify: (args) => (args.includes(marker) ? "tui" : null),
                });
            });
            const byPid = new Map(rows.map((row) => [row.pid, row]));
            const tty = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(process.pid)], { env: process.env })
                .stdout.toString()
                .trim();

            expect([...byPid.keys()].sort()).toEqual(probes.map((probe) => probe.pid).sort());
            expect(probes.map((probe) => byPid.get(probe.pid)?.account ?? null)).toEqual([null, "work laptop", null]);
            expect(probes.map((probe) => byPid.get(probe.pid)?.proxyTarget ?? null)).toEqual([null, null, "openai"]);

            for (const row of rows) {
                expect(row.ppid).toBe(process.pid);
                expect(row.kind).toBe("tui");
                expect(row.tty).toBe(tty);
                expect(row.args).toBe(`${process.execPath} -e ${code} ${marker}`);
                expect(row.cwd).toBe(dir);
                expect(row.cpuTime).toMatch(/^\d+:\d\d\.\d\d$/);
                // `ps lstart` has whole seconds.
                expect((row.startedAt ?? 0) % 1000).toBe(0);
                expect(Math.abs((row.startedAt ?? 0) - started)).toBeLessThan(2000);
            }
        } finally {
            for (const probe of probes) {
                probe.kill();
            }

            await Promise.all(probes.map((probe) => probe.exited));
        }
    });

    test("a row whose owner the platform cannot name (a Windows CIM row) is kept, not filtered as another user's", async () => {
        const row = {
            pid: process.pid,
            ppid: process.ppid,
            pgid: process.pid,
            uid: null,
            name: "bun",
            command: "bun agent-marker",
            tty: null,
            startMs: Date.now() - 5000,
            zombie: false,
            state: "S",
        };
        const layer = spyOn(processes, "listProcesses").mockReturnValue([row]);

        try {
            const rows = await listActiveAgentProcesses({
                alias: "claude",
                classify: (args) => (args.includes("agent-marker") ? "tui" : null),
            });

            expect(rows.map((found) => found.pid)).toEqual([process.pid]);
        } finally {
            layer.mockRestore();
        }
    });

    test.skipIf(process.platform !== "darwin")(
        "task usage is read for the agents only, not for every process on the machine",
        async () => {
            const read = spyOn(kernel, "readProcessUsage");
            const unused = `gt-who-none-${crypto.randomUUID()}`;
            let reads = -1;

            try {
                const rows = await listActiveAgentProcesses({
                    alias: "claude",
                    classify: (args) => (args.includes(unused) ? "tui" : null),
                });
                reads = read.mock.calls.length;
                expect(rows).toEqual([]);
            } finally {
                read.mockRestore();
            }

            // One kernel read per listed process is hundreds; no agent means none.
            expect(reads).toBe(0);
        }
    );

    test("reads the process table without spawning ps or lsof", async () => {
        const spawn = spyOn(Bun, "spawn");

        try {
            await listActiveAgentProcesses({ alias: "claude", classify: () => "tui" });
            expect(spawn.mock.calls.length).toBe(0);
        } finally {
            spawn.mockRestore();
        }
    });
});
