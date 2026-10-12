import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunchctlList } from "@genesiscz/utils/process/launchctl";
import {
    commandOfRow,
    formatPsCpuTime,
    listProcessTable,
    processTableAvailable,
    readProcessArgs,
    readProcessPath,
    readProcessRow,
    readProcessUsage,
    readPsCommand,
} from "@genesiscz/utils/process/libproc-table";
import {
    batchCwd,
    batchCwdViaLsof,
    capture,
    chunk,
    collectProcessTree,
    PS_BATCH_SIZE,
    type PsRow,
    parseCpuTime,
    parseOpenFileCounts,
    parsePsLine,
    parsePsList,
    parsePsTable,
    processBasename,
} from "@genesiscz/utils/process/ps";
import { readProcessInfo } from "@genesiscz/utils/process/socket-owner";
import { parseTopPower, readTopEnergy } from "@genesiscz/utils/process/top";

function fakeRow(pid: number, ppid: number): PsRow {
    return { pid, ppid, user: "alice", stat: "S", cpu: 0, rss: 0, startTime: null, command: `pid-${pid}` };
}

/** Processes of our own for the live tests: a sleeper in `dir`, a pid that already exited, and a zombie. */
interface LiveFixture {
    dir: string;
    sleeper: Bun.Subprocess;
    exitedPid: number;
    zombiePid: number;
    zombieHolder: Bun.Subprocess;
}

async function startLiveFixture(): Promise<LiveFixture> {
    // A space in the folder name: lsof prints the path as the last columns of a space-split line.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ps live-")));
    const quiet = { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;
    const sleeper = Bun.spawn(["/bin/sleep", "30"], { ...quiet, cwd: dir });
    const exited = Bun.spawn(["/usr/bin/true"], quiet);
    await exited.exited;

    // `sh` backgrounds `sleep 0`, prints its pid, then becomes `sleep 30`, which never reaps the child.
    const zombieHolder = Bun.spawn(["/bin/sh", "-c", "/bin/sleep 0 & echo $!; exec /bin/sleep 30"], {
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
    });
    const { value } = await zombieHolder.stdout.getReader().read();
    const zombiePid = Number(new TextDecoder().decode(value).trim());
    const deadline = Date.now() + 5_000;

    // A zombie no longer answers libproc's bsd info, which is how we know `sleep 0` has exited.
    while (readProcessInfo(zombiePid) !== null) {
        if (Date.now() > deadline) {
            throw new Error(`pid ${zombiePid} did not become a zombie within 5 s`);
        }

        await Bun.sleep(20);
    }

    return { dir, sleeper, exitedPid: exited.pid, zombiePid, zombieHolder };
}

async function stopLiveFixture(fixture: LiveFixture): Promise<void> {
    fixture.sleeper.kill();
    fixture.zombieHolder.kill();
    await Promise.all([fixture.sleeper.exited, fixture.zombieHolder.exited]);
}

const UNUSED_PID = 0x7ffffff;

// Real `ps` and `lsof` output shapes, with invented user names.
const PS_INFO_LINE = "17512 40508 alice    Ss     0.4   3584 Wed Sep 16 17:58:55 2026 /bin/zsh -c echo hello world";

const PS_LIST_OUTPUT = [
    "    1   0.9  28624 /sbin/launchd",
    "  155   0.0  26512 /System/Library/Frameworks/Metadata.framework/Support/mdworker_shared -s mdworker",
    " 4021  12.5 170288 /opt/homebrew/bin/bun run src/macos-resources/index.tsx",
    "",
].join("\n");

const LSOF_FIELD_OUTPUT = ["p4021", "fcwd", "ftxt", "f0", "f1", "f2", "p155", "fcwd", "ftxt", "p9999", ""].join("\n");

describe("chunk", () => {
    test("splits into fixed-size batches with a short tail", () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    test("returns nothing for an empty list", () => {
        expect(chunk([], PS_BATCH_SIZE)).toEqual([]);
    });
});

describe("parsePsLine", () => {
    test("reads every column of the batchPsInfo spec", () => {
        const row = parsePsLine(PS_INFO_LINE);

        expect(row).not.toBeNull();
        expect(row?.pid).toBe(17512);
        expect(row?.ppid).toBe(40508);
        expect(row?.user).toBe("alice");
        expect(row?.stat).toBe("Ss");
        expect(row?.cpu).toBe(0.4);
        expect(row?.rss).toBe(3584);
        expect(row?.command).toBe("/bin/zsh -c echo hello world");
        expect(row?.startTime?.getFullYear()).toBe(2026);
    });

    test("returns null for a line that is not a ps row", () => {
        expect(parsePsLine("  PID  PPID USER")).toBeNull();
        expect(parsePsLine("")).toBeNull();
    });
});

describe("parsePsTable", () => {
    test("reads every row of a whole-table dump and skips the lines that are not rows", () => {
        const stdout = [
            "    1     0 root     Ss     0.9  28624 Mon Sep 14 08:00:01 2026 /sbin/launchd",
            PS_INFO_LINE,
            "garbage",
            "",
        ].join("\n");
        const rows = parsePsTable(stdout);

        expect(rows.map((row) => row.pid)).toEqual([1, 17512]);
        expect(rows[1]?.ppid).toBe(40508);
        expect(rows[0]?.command).toBe("/sbin/launchd");
    });
});

describe("parsePsList", () => {
    test("parses pid, cpu, rss and the whole remaining argv", () => {
        const rows = parsePsList(PS_LIST_OUTPUT);

        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({ pid: 1, cpu: 0.9, rssKb: 28624, command: "/sbin/launchd" });
        expect(rows[2].pid).toBe(4021);
        expect(rows[2].cpu).toBe(12.5);
        expect(rows[2].rssKb).toBe(170288);
        expect(rows[2].command).toBe("/opt/homebrew/bin/bun run src/macos-resources/index.tsx");
    });

    test("keeps spaces inside the command instead of splitting on them", () => {
        const rows = parsePsList("  155   0.0  26512 /a/b -s mdworker -c MDSImporterWorker");

        expect(rows[0].command).toBe("/a/b -s mdworker -c MDSImporterWorker");
    });

    test("skips lines that are not rows rather than emitting NaN", () => {
        const rows = parsePsList(["  PID %CPU   RSS COMMAND", "garbage", "", "  7   1.0  10 /bin/x"].join("\n"));

        expect(rows).toHaveLength(1);
        expect(rows[0].pid).toBe(7);
    });
});

describe("parseOpenFileCounts", () => {
    test("counts f records inside each p section", () => {
        const counts = parseOpenFileCounts(LSOF_FIELD_OUTPUT);

        expect(counts.get(4021)).toBe(5);
        expect(counts.get(155)).toBe(2);
    });

    test("reports a pid lsof answered for with no files as 0, not as absent", () => {
        const counts = parseOpenFileCounts(LSOF_FIELD_OUTPUT);

        expect(counts.has(9999)).toBe(true);
        expect(counts.get(9999)).toBe(0);
    });

    test("leaves a pid lsof never mentioned absent, so unknown stays apart from zero", () => {
        const counts = parseOpenFileCounts(LSOF_FIELD_OUTPUT);

        expect(counts.has(1234)).toBe(false);
    });

    test("ignores f records that arrive before any p section", () => {
        expect(parseOpenFileCounts(["fcwd", "f0", "p5", "f1"].join("\n")).get(5)).toBe(1);
    });

    test("returns nothing for empty output", () => {
        expect(parseOpenFileCounts("").size).toBe(0);
    });
});

describe("parseCpuTime", () => {
    test("parses macOS mm:ss.cc, hh:mm:ss, and dd-hh:mm:ss", () => {
        expect(parseCpuTime("0:00.01")).toBe(10);
        expect(parseCpuTime("0:00.44")).toBe(440);
        expect(parseCpuTime("8:03.60")).toBe(483_600);
        expect(parseCpuTime("12:34.56")).toBe(754_560);
        expect(parseCpuTime("01:02:03")).toBe(3_723_000);
        expect(parseCpuTime("1:02:03.50")).toBe(3_723_500);
        expect(parseCpuTime("5-23:12:45")).toBe(5 * 86_400_000 + 83_565_000);
        expect(parseCpuTime("1-02:03:04.50")).toBe(93_784_500);
    });

    test("returns null rather than zero for something it cannot read", () => {
        expect(parseCpuTime("")).toBeNull();
        expect(parseCpuTime("   ")).toBeNull();
        expect(parseCpuTime("not-a-time")).toBeNull();
        expect(parseCpuTime("garbage")).toBeNull();
        expect(parseCpuTime("1:2:3:4")).toBeNull();
    });
});

function sortedByPid<T>(map: Map<number, T>): Map<number, T> {
    return new Map([...map].sort(([a], [b]) => a - b));
}

/** Both readers must answer exactly this for the live fixture: the old `lsof` path and the libproc one. */
async function expectLiveCwds(read: (pids: number[]) => Map<number, string>): Promise<void> {
    const fixture = await startLiveFixture();

    try {
        const pids = [
            process.pid,
            fixture.sleeper.pid,
            fixture.exitedPid,
            fixture.zombiePid,
            1,
            UNUSED_PID,
            fixture.zombieHolder.pid,
        ];
        const ownCwd = realpathSync(process.cwd());
        // launchd belongs to root: unreadable unless the suite itself runs as root.
        const expected = new Map<number, string>([
            [process.pid, ownCwd],
            [fixture.sleeper.pid, fixture.dir],
            [fixture.zombieHolder.pid, ownCwd],
        ]);

        if (process.getuid?.() === 0) {
            expected.set(1, "/");
        }

        expect(sortedByPid(read(pids))).toEqual(sortedByPid(expected));
    } finally {
        await stopLiveFixture(fixture);
    }
}

describe.skipIf(process.platform !== "darwin")("batchCwd on live processes", () => {
    test("answers our own and a child's cwd, and leaves exited, zombie, foreign and unknown pids out", async () => {
        await expectLiveCwds(batchCwd);
    });

    test("the lsof fallback answers the same set as the kernel read", async () => {
        await expectLiveCwds(batchCwdViaLsof);
    });

    test("an empty list answers an empty map, on both paths", () => {
        expect(batchCwd([]).size).toBe(0);
        expect(batchCwdViaLsof([]).size).toBe(0);
    });
});

describe("formatPsCpuTime", () => {
    test("prints minutes past the hour and rounds to the nearest hundredth, as ps -o time= does", () => {
        expect(formatPsCpuTime(0)).toBe("0:00.00");
        expect(formatPsCpuTime(4_796_430)).toBe("79:56.43");
        expect(formatPsCpuTime(64.999)).toBe("0:00.06");
        expect(formatPsCpuTime(65)).toBe("0:00.07");
        expect(formatPsCpuTime(59_999)).toBe("1:00.00");
    });
});

describe.skipIf(process.platform !== "darwin")("libproc process table against ps", () => {
    test("rows carry the parent, uid, terminal, start second and command that ps prints", async () => {
        const fixture = await startLiveFixture();

        try {
            const pids = [process.pid, fixture.sleeper.pid, fixture.zombiePid, fixture.zombieHolder.pid, 1];
            const printed = new Map<number, string[]>();
            const psOut = Bun.spawnSync(["ps", "-o", "pid=,ppid=,uid=,tty=,command=", "-p", pids.join(",")], {
                env: process.env,
            });

            for (const line of psOut.stdout.toString().split("\n")) {
                const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);

                if (match) {
                    printed.set(Number(match[1]), [match[2], match[3], match[4], match[5].trim()]);
                }
            }

            const table = listProcessTable() ?? [];
            const euid = process.geteuid?.();

            for (const pid of pids) {
                const row = table.find((candidate) => candidate.pid === pid);
                const expected = printed.get(pid);

                expect(row).toBeDefined();
                expect([String(row?.ppid), String(row?.uid), row?.tty ?? "??"]).toEqual(expected?.slice(0, 3) ?? []);

                // Another user's argv only setuid ps can read; for those the table names the executable instead.
                if (row && row.uid === euid) {
                    expect(commandOfRow(row)).toBe(expected?.[3] ?? "no ps row");
                }
            }

            expect(table.find((row) => row.pid === fixture.zombiePid)?.zombie).toBe(true);
            expect(table.some((row) => row.pid === fixture.exitedPid)).toBe(false);
            expect(readProcessRow(fixture.exitedPid)).toBeNull();
            expect(Math.abs((readProcessRow(fixture.sleeper.pid)?.startMs ?? 0) - Date.now())).toBeLessThan(10_000);
        } finally {
            await stopLiveFixture(fixture);
        }
    });

    test("argv and environment come back raw for our own process, and not at all for root's or a zombie", async () => {
        const fixture = await startLiveFixture();
        const marker = `ps-test-${crypto.randomUUID()}`;
        const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", "a\tb", ""], {
            env: { ...process.env, LIBPROC_TABLE_MARKER: marker },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });

        try {
            const args = readProcessArgs(child.pid, { env: true });

            expect(args?.argv).toEqual([process.execPath, "-e", "setTimeout(() => {}, 30000)", "a\tb", ""]);
            expect(args?.env).toContain(`LIBPROC_TABLE_MARKER=${marker}`);
            expect(readProcessArgs(child.pid)?.env).toEqual([]);
            expect(readPsCommand(child.pid)).toBe(`${process.execPath} -e setTimeout(() => {}, 30000) a\\011b`);
            expect(readPsCommand(child.pid, { env: true })).toContain(` LIBPROC_TABLE_MARKER=${marker}`);
            expect(readProcessArgs(1)).toBeNull();
            expect(readProcessArgs(fixture.zombiePid)).toBeNull();
            expect(readProcessPath(1)).toBe("/sbin/launchd");
            expect(readProcessUsage(1)).toBeNull();
            expect(readProcessUsage(process.pid)?.rssBytes ?? 0).toBeGreaterThan(0);
            expect(readProcessUsage(process.pid)?.cpuTimeMs ?? 0).toBeGreaterThan(0);
            expect(readProcessRow(1)?.uid).toBe(0);
        } finally {
            child.kill();
            await child.exited;
            await stopLiveFixture(fixture);
        }
    });
});

describe.skipIf(process.platform === "darwin")("libproc process table off macOS", () => {
    test("answers null everywhere, so every caller keeps ps", () => {
        expect(processTableAvailable()).toBe(false);
        expect(listProcessTable()).toBeNull();
        expect(readProcessRow(process.pid)).toBeNull();
        expect(readProcessArgs(process.pid)).toBeNull();
        expect(readPsCommand(process.pid)).toBeNull();
        expect(readProcessUsage(process.pid)).toBeNull();
    });
});

describe("capture timeout", () => {
    test("returns after the deadline instead of waiting on streams", async () => {
        const started = performance.now();
        const result = await capture("/bin/sleep", ["30"], { timeoutMs: 80 });

        expect(performance.now() - started).toBeLessThan(2000);
        expect(result.status).toBeNull();
        expect(result.stdout).toBe("");
        expect(result.timedOut).toBe(true);
    });

    test("a child that exits in time is not marked as timed out", async () => {
        const result = await capture("/usr/bin/true", [], { timeoutMs: 5_000 });

        expect(result.status).toBe(0);
        expect(result.timedOut).toBeUndefined();
    });
});

describe("processBasename", () => {
    test("takes the basename of argv[0] and drops the arguments", () => {
        expect(processBasename("/opt/homebrew/bin/bun run src/x.tsx")).toBe("bun");
        expect(processBasename("/sbin/launchd")).toBe("launchd");
        expect(processBasename("mdworker_shared -s mdworker")).toBe("mdworker_shared");
    });

    test("survives an empty command", () => {
        expect(processBasename("")).toBe("");
        expect(processBasename("   ")).toBe("");
    });
});

describe("collectProcessTree", () => {
    test("walks every descendant, not just direct children", () => {
        const rows = [
            fakeRow(1, 0),
            fakeRow(10, 1), // root
            fakeRow(11, 10), // child of root
            fakeRow(12, 10), // child of root
            fakeRow(13, 11), // grandchild, via 11
            fakeRow(99, 1), // unrelated sibling — must not appear
        ];

        const tree = collectProcessTree(10, rows);

        expect(new Set(tree)).toEqual(new Set([10, 11, 12, 13]));
        expect(tree).not.toContain(99);
    });

    test("includes the root even when it is not itself in rows", () => {
        expect(collectProcessTree(404, [fakeRow(1, 0)])).toEqual([404]);
    });

    test("does not loop forever on a cyclic ppid graph", () => {
        // Not a shape the kernel can produce, but the walk must still terminate.
        const rows = [fakeRow(10, 11), fakeRow(11, 10)];

        expect(new Set(collectProcessTree(10, rows))).toEqual(new Set([10, 11]));
    });
});

describe("launchctl list and top power parsers", () => {
    test("launchctl list: running jobs only", () => {
        const jobs = parseLaunchctlList(
            "PID\tStatus\tLabel\n330\t0\tcom.example.mcp-gateway\n-\t0\tcom.example.idle\n"
        );

        expect([...jobs]).toEqual([[330, "com.example.mcp-gateway"]]);
    });

    test("top: the second sample's PID POWER table", () => {
        const stdout = [
            "PID    POWER",
            "210    0.0",
            "",
            "Processes: 700 total",
            "PID    POWER",
            "210    4.7 ",
            "300    12.5",
            "",
        ].join("\n");

        expect([...parseTopPower(stdout)]).toEqual([
            [210, 4.7],
            [300, 12.5],
        ]);
    });
    test("top: a failed run is no figures at all, not the first sample's zeros, and a spawn error is not fatal", async () => {
        const partial = async () => ({ status: 1, stdout: "PID    POWER\n210    0.0\n", stderr: "interrupted" });
        const broken = async (): Promise<never> => {
            throw new Error("spawn top ENOENT");
        };

        expect((await readTopEnergy(partial)).size).toBe(0);
        expect((await readTopEnergy(broken)).size).toBe(0);
    });
});
