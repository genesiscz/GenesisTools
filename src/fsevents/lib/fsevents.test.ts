import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryCounter } from "./churn";
import { formatChurnReport, formatWatchersReport } from "./format";
import { resolveSampleRoot } from "./sample";
import { parseFsUsageWatchers, streamLines } from "./watchers";

function counterWith(paths: string[]): DirectoryCounter {
    const counter = new DirectoryCounter();

    for (const path of paths) {
        counter.add(path);
    }

    return counter;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }

            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
    const lines: string[] = [];

    for await (const line of streamLines(stream)) {
        lines.push(line);
    }

    return lines;
}

describe("DirectoryCounter", () => {
    it("counts each event toward the parent directory of the item", () => {
        const profile = counterWith(["/a/b/one.txt", "/a/b/two.txt", "/a/b/sub", "/a/c/three.txt"]).snapshot(10);

        expect(profile.total).toBe(4);
        expect(profile.distinctDirectories).toBe(2);
        expect(profile.top.map((entry) => [entry.directory, entry.count])).toEqual([
            ["/a/b", 3],
            ["/a/c", 1],
        ]);
    });

    it("ranks the busiest directory first and breaks a tie by path", () => {
        const profile = counterWith(["/z/x", "/y/x", "/y/y", "/z/y", "/m/x"]).snapshot(10);

        expect(profile.top.map((entry) => entry.directory)).toEqual(["/y", "/z", "/m"]);
    });

    it("keeps only the requested number of directories but still counts every event", () => {
        const profile = counterWith(["/a/1", "/a/2", "/b/1", "/c/1"]).snapshot(1);

        expect(profile.top).toHaveLength(1);
        expect(profile.top[0]?.directory).toBe("/a");
        expect(profile.total).toBe(4);
        expect(profile.distinctDirectories).toBe(3);
    });

    it("reports each directory's share of all events", () => {
        const profile = counterWith(["/a/1", "/a/2", "/a/3", "/b/1"]).snapshot(2);

        expect(profile.top.map((entry) => entry.share)).toEqual([0.75, 0.25]);
    });

    it("has an empty profile before any event", () => {
        expect(new DirectoryCounter().snapshot(5)).toEqual({ total: 0, distinctDirectories: 0, top: [] });
    });

    it("files an event on the root under the root itself", () => {
        expect(counterWith(["/"]).snapshot(1).top[0]?.directory).toBe("/");
    });
});

describe("formatChurnReport", () => {
    it("prints a ranked table with the full path of every directory", () => {
        const longPath = `/very/${"long/".repeat(30)}dir`;
        const profile = counterWith([`${longPath}/f`, `${longPath}/g`, "/b/f"]).snapshot(5);

        expect(formatChurnReport(profile, { root: "/", elapsedMs: 5000, interrupted: false })).toBe(
            [
                "3 events in 2 directories under / (5.0 s).",
                "",
                "Top 2 most active:",
                "EVENTS  SHARE  DIRECTORY",
                `──────  ─────  ${"─".repeat(longPath.length)}`,
                `     2  66.7%  ${longPath}`,
                "     1  33.3%  /b",
                "",
                "Look for caches, build output directories and cloud sync folders in this list.",
            ].join("\n")
        );
    });

    it("says so when the sample ended early", () => {
        const profile = counterWith(["/a/1"]).snapshot(5);
        const report = formatChurnReport(profile, { root: "/a", elapsedMs: 1250, interrupted: true });

        expect(report.split("\n")[0]).toBe("1 event in 1 directory under /a (1.3 s, stopped early).");
    });

    it("rounds a tiny share to a floor instead of 0.0%", () => {
        const counter = new DirectoryCounter();

        for (let index = 0; index < 5000; index++) {
            counter.add("/busy/f");
        }

        counter.add("/quiet/f");

        expect(formatChurnReport(counter.snapshot(2), { root: "/", elapsedMs: 1000, interrupted: false })).toContain(
            "<0.1%"
        );
    });

    it("reports an empty sample in one line", () => {
        expect(
            formatChurnReport(new DirectoryCounter().snapshot(5), { root: "/x", elapsedMs: 2000, interrupted: false })
        ).toBe("No file system events under /x (2.0 s).");
    });
});

describe("parseFsUsageWatchers", () => {
    const open = (process: string) =>
        `10:30:01.123456  open              F=5    (R_____)  /dev/fsevents      0.000020   ${process}`;

    it("groups the lines that name the device by process and counts distinct threads", () => {
        const watchers = parseFsUsageWatchers([
            open("mds_stores.4821"),
            open("Finder.9001"),
            open("mds_stores.4821"),
            open("mds_stores.4822"),
            "10:30:01.200000  stat              /Users/x/file      0.000010   Finder.9001",
        ]);

        expect(watchers).toEqual([
            { command: "mds_stores", opens: 3, threadIds: [4821, 4822] },
            { command: "Finder", opens: 1, threadIds: [9001] },
        ]);
    });

    it("keeps a process name that holds a space and reads a W after the elapsed time", () => {
        const line = "10:30:01.123456  open  F=5  (R_____)  /dev/fsevents  0.000020 W  Google Chrome H.7788";

        expect(parseFsUsageWatchers([line])).toEqual([{ command: "Google Chrome H", opens: 1, threadIds: [7788] }]);
    });

    it("skips a matching line that ends without a process", () => {
        expect(parseFsUsageWatchers(["open /dev/fsevents"])).toEqual([]);
    });

    it("sorts equal counts by process name", () => {
        const watchers = parseFsUsageWatchers([open("zeta.1"), open("alpha.2")]);

        expect(watchers.map((watcher) => watcher.command)).toEqual(["alpha", "zeta"]);
    });

    it("returns nothing for no lines", () => {
        expect(parseFsUsageWatchers([])).toEqual([]);
    });
});

describe("formatWatchersReport", () => {
    it("lists each process with its opens and thread count", () => {
        const report = formatWatchersReport([{ command: "mds_stores", opens: 3, threadIds: [4821, 4822] }], {
            elapsedMs: 5000,
        });

        expect(report).toBe(
            [
                "1 process opened /dev/fsevents during the 5.0 s sample:",
                "OPENS  THREADS  PROCESS",
                "─────  ───────  ──────────",
                "    3        2  mds_stores",
            ].join("\n")
        );
    });

    it("explains an empty result", () => {
        expect(formatWatchersReport([], { elapsedMs: 5000 })).toContain(
            "No process opened /dev/fsevents during the 5.0 s"
        );
    });
});

describe("streamLines", () => {
    const encoder = new TextEncoder();

    it("joins a line that arrives in two chunks", async () => {
        const lines = await collect(streamOf(encoder.encode("first\nsec"), encoder.encode("ond\nthird\n")));

        expect(lines).toEqual(["first", "second", "third"]);
    });

    it("yields a last line that has no newline", async () => {
        expect(await collect(streamOf(encoder.encode("a\nb")))).toEqual(["a", "b"]);
    });

    it("does not split a multi-byte character across chunks", async () => {
        const bytes = encoder.encode("café\n");

        expect(await collect(streamOf(bytes.slice(0, 4), bytes.slice(4)))).toEqual(["café"]);
    });

    it("yields nothing for an empty stream", async () => {
        expect(await collect(streamOf())).toEqual([]);
    });
});

describe("resolveSampleRoot", () => {
    it("returns the real path of an existing directory", () => {
        const dir = mkdtempSync(join(tmpdir(), "fsevents-root-"));

        expect(resolveSampleRoot(dir)).toBe(realpathSync(dir));
    });

    it("refuses a missing path", () => {
        expect(() => resolveSampleRoot(join(tmpdir(), "fsevents-no-such-directory"))).toThrow("does not exist");
    });

    it("refuses a file", () => {
        const file = join(mkdtempSync(join(tmpdir(), "fsevents-root-")), "plain.txt");
        writeFileSync(file, "x");

        expect(() => resolveSampleRoot(file)).toThrow("not a directory");
    });
});

describe("tools fsevents entrypoint", () => {
    it.skipIf(process.platform === "darwin")("refuses valid sampling on systems without FSEvents", async () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), "gt-fsevents-platform-"));

        try {
            const proc = Bun.spawn({
                cmd: ["bun", "run", join(import.meta.dir, "../index.ts"), "profile", "--duration", "1"],
                env: { ...process.env, GENESIS_TOOLS_HOME: fixtureRoot, NO_COLOR: "1" },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);

            expect(exitCode).toBe(1);
            expect(stderr).toContain("profile needs macOS");
            expect(stdout).toBe("");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    it("prints a failure once and keeps the error with its stack in the day log", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-fsevents-home-"));

        try {
            const proc = Bun.spawn({
                cmd: ["bun", "run", join(import.meta.dir, "../index.ts"), "profile", "--duration", "abc"],
                env: { ...process.env, GENESIS_TOOLS_HOME: home, NO_COLOR: "1" },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
            const logDir = join(home, ".genesis-tools", "logs");
            const log = readdirSync(logDir)
                .map((name) => readFileSync(join(logDir, name), "utf-8"))
                .join("\n");

            expect(exitCode).toBe(1);
            expect(stderr.split('--duration must be a positive number, got "abc".').length - 1).toBe(1);
            expect(log).toContain("--duration must be a positive number");
            expect(log).toContain("positiveNumber");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
