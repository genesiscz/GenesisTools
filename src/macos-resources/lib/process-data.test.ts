import { describe, expect, test } from "bun:test";
import {
    applyOpenFileCounts,
    matchesFilter,
    nextSortBy,
    OPEN_FILES_TTL_MS,
    type ProcessInfo,
    parseOpenFiles,
    planOpenFilesRefresh,
    sortProcesses,
    toProcessInfos,
    UNKNOWN_OPEN_FILES,
} from "@app/macos-resources/lib/process-data";
import { parsePsList } from "@genesiscz/utils/process/ps";

const PS_OUTPUT = [
    "    1   0.9  28624 /sbin/launchd",
    "  155   0.4  26512 /System/Library/Support/mdworker_shared -s mdworker",
    " 4021  12.5 174080 /opt/homebrew/bin/bun run src/macos-resources/index.tsx",
    " 5150   3.0  51200 /Applications/Widget.app/Contents/MacOS/widget --profile work",
].join("\n");

const LSOF_COLUMNS = [
    "COMMAND   PID   USER   FD   TYPE DEVICE  SIZE/OFF   NODE NAME",
    "bun      4021  alice  cwd    DIR 1,17         832 123456 /Users/alice/repo",
    "bun      4021  alice  txt    REG 1,17     1048576 123457 /opt/homebrew/bin/bun",
    "bun      4021  alice    0u   CHR 16,2       0t120    900 /dev/ttys002",
].join("\n");

function row(pid: number, overrides: Partial<ProcessInfo> = {}): ProcessInfo {
    return {
        pid,
        name: `proc-${pid}`,
        cpu: 1,
        memoryMB: 10,
        openFiles: UNKNOWN_OPEN_FILES,
        command: `/usr/bin/proc-${pid}`,
        ...overrides,
    };
}

describe("matchesFilter", () => {
    const candidate = { pid: 4021, name: "bun", command: "/opt/homebrew/bin/bun run src/macos-resources/index.tsx" };

    test("an empty filter keeps everything", () => {
        expect(matchesFilter(candidate, "")).toBe(true);
    });

    test("a numeric filter is an exact pid, not a substring", () => {
        expect(matchesFilter(candidate, "4021")).toBe(true);
        expect(matchesFilter(candidate, "402")).toBe(false);
        expect(matchesFilter({ ...candidate, pid: 40210 }, "4021")).toBe(false);
    });

    test("a text filter matches the name or the command, case-insensitively", () => {
        expect(matchesFilter(candidate, "BUN")).toBe(true);
        expect(matchesFilter(candidate, "macos-resources")).toBe(true);
        expect(matchesFilter(candidate, "chrome")).toBe(false);
    });
});

describe("toProcessInfos", () => {
    test("derives name and memory from the ps row", () => {
        const processes = toProcessInfos(parsePsList(PS_OUTPUT), { filter: "", previous: [] });

        expect(processes).toHaveLength(4);
        expect(processes[0]).toEqual({
            pid: 1,
            name: "launchd",
            cpu: 0.9,
            memoryMB: 28624 / 1024,
            openFiles: UNKNOWN_OPEN_FILES,
            command: "/sbin/launchd",
        });
        expect(processes[3].name).toBe("widget");
    });

    test("applies the filter", () => {
        const processes = toProcessInfos(parsePsList(PS_OUTPUT), { filter: "mdworker", previous: [] });

        expect(processes.map((p) => p.pid)).toEqual([155]);
    });

    test("carries a known open-file count across the refresh", () => {
        const previous = [row(4021, { openFiles: 512 }), row(155, { openFiles: UNKNOWN_OPEN_FILES })];
        const processes = toProcessInfos(parsePsList(PS_OUTPUT), { filter: "", previous });

        expect(processes.find((p) => p.pid === 4021)?.openFiles).toBe(512);
        expect(processes.find((p) => p.pid === 155)?.openFiles).toBe(UNKNOWN_OPEN_FILES);
        expect(processes.find((p) => p.pid === 1)?.openFiles).toBe(UNKNOWN_OPEN_FILES);
    });
});

describe("sortProcesses", () => {
    const processes = [row(30, { cpu: 1, openFiles: 90 }), row(10, { cpu: 9, openFiles: 5 }), row(20, { cpu: 5 })];

    test("cpu descending", () => {
        expect(sortProcesses(processes, "cpu").map((p) => p.pid)).toEqual([10, 20, 30]);
    });

    test("pid ascending", () => {
        expect(sortProcesses(processes, "pid").map((p) => p.pid)).toEqual([10, 20, 30]);
    });

    test("files descending, with unknown counts last", () => {
        expect(sortProcesses(processes, "files").map((p) => p.pid)).toEqual([30, 10, 20]);
    });

    test("does not mutate the input", () => {
        const input = [...processes];
        sortProcesses(input, "cpu");
        expect(input.map((p) => p.pid)).toEqual([30, 10, 20]);
    });
});

describe("nextSortBy", () => {
    test("cycles cpu → files → pid → cpu", () => {
        expect(nextSortBy("cpu")).toBe("files");
        expect(nextSortBy("files")).toBe("pid");
        expect(nextSortBy("pid")).toBe("cpu");
    });
});

describe("planOpenFilesRefresh", () => {
    const now = 1_000_000;

    test("asks for pids it has never asked about", () => {
        const due = planOpenFilesRefresh({
            processes: [row(500), row(600, { openFiles: 12 })],
            lastFilesUpdate: new Map([[600, now]]),
            selectedPid: null,
            now,
        });

        expect(due).toEqual([500]);
    });

    test("does NOT re-ask a pid that answered nothing, until its TTL expires", () => {
        // lsof refuses processes owned by other users, so these rows stay unknown
        // for the whole session. Keying the refresh on the count rather than on the
        // stamp re-asked every one of them on every cycle.
        const refused = row(500, { openFiles: UNKNOWN_OPEN_FILES });

        expect(
            planOpenFilesRefresh({
                processes: [refused],
                lastFilesUpdate: new Map([[500, now]]),
                selectedPid: null,
                now,
            })
        ).toEqual([]);

        expect(
            planOpenFilesRefresh({
                processes: [refused],
                lastFilesUpdate: new Map([[500, now - OPEN_FILES_TTL_MS]]),
                selectedPid: null,
                now,
            })
        ).toEqual([500]);
    });

    test("always re-reads the selected pid, even inside the TTL", () => {
        const due = planOpenFilesRefresh({
            processes: [row(500, { openFiles: 3 }), row(600, { openFiles: 12 })],
            lastFilesUpdate: new Map([
                [500, now],
                [600, now],
            ]),
            selectedPid: 600,
            now,
        });

        expect(due).toEqual([600]);
    });

    test("re-reads a pid once its TTL expired", () => {
        const lastFilesUpdate = new Map([[500, now - OPEN_FILES_TTL_MS]]);
        const due = planOpenFilesRefresh({
            processes: [row(500, { openFiles: 3 })],
            lastFilesUpdate,
            selectedPid: null,
            now,
        });

        expect(due).toEqual([500]);
    });

    test("skips low pids and the kernel, which lsof cannot answer for", () => {
        const due = planOpenFilesRefresh({
            processes: [row(1), row(100), row(101), row(700, { name: "kernel_task" })],
            lastFilesUpdate: new Map(),
            selectedPid: null,
            now,
        });

        expect(due).toEqual([101]);
    });

    test("force asks for every eligible pid regardless of the TTL", () => {
        const lastFilesUpdate = new Map([
            [500, now],
            [600, now],
        ]);
        const due = planOpenFilesRefresh({
            processes: [row(500, { openFiles: 3 }), row(600, { openFiles: 12 })],
            lastFilesUpdate,
            selectedPid: null,
            now,
            force: true,
        });

        expect(due).toEqual([500, 600]);
    });
});

describe("applyOpenFileCounts", () => {
    const now = 2_000_000;

    test("folds answered counts in and stamps every requested pid", () => {
        const result = applyOpenFileCounts([row(500), row(600)], new Map([[500, 42]]), {
            requested: [500, 600],
            lastFilesUpdate: new Map(),
            now,
        });

        expect(result.processes.find((p) => p.pid === 500)?.openFiles).toBe(42);
        expect(result.lastFilesUpdate.get(500)).toBe(now);
        expect(result.lastFilesUpdate.get(600)).toBe(now);
    });

    test("a pid lsof refused keeps its previous count instead of dropping to zero", () => {
        const result = applyOpenFileCounts([row(600, { openFiles: 7 })], new Map(), {
            requested: [600],
            lastFilesUpdate: new Map(),
            now,
        });

        expect(result.processes[0].openFiles).toBe(7);
    });

    test("an answered zero is recorded as zero, not as unknown", () => {
        const result = applyOpenFileCounts([row(600)], new Map([[600, 0]]), {
            requested: [600],
            lastFilesUpdate: new Map(),
            now,
        });

        expect(result.processes[0].openFiles).toBe(0);
    });

    test("forgets pids that are no longer running, so the map cannot grow forever", () => {
        const result = applyOpenFileCounts([row(500)], new Map([[500, 1]]), {
            requested: [500],
            lastFilesUpdate: new Map([[999, now - 1]]),
            now,
        });

        expect(result.lastFilesUpdate.has(999)).toBe(false);
        expect(result.lastFilesUpdate.has(500)).toBe(true);
    });
});

describe("parseOpenFiles", () => {
    test("reads fd, type and name, and sorts by type then name", () => {
        const files = parseOpenFiles(LSOF_COLUMNS);

        expect(files).toHaveLength(3);
        expect(files[0]).toEqual({ fd: "0u", type: "CHR", name: "/dev/ttys002" });
        expect(files[1].type).toBe("DIR");
        expect(files[2].type).toBe("REG");
    });

    test("returns nothing for empty output or a header-only listing", () => {
        expect(parseOpenFiles("")).toEqual([]);
        expect(parseOpenFiles("COMMAND   PID   USER   FD   TYPE DEVICE  SIZE/OFF   NODE NAME")).toEqual([]);
    });

    test("keeps spaces inside a path", () => {
        const files = parseOpenFiles(
            ["HEADER", "bun  4021 alice  12r  REG 1,17  10 900 /Users/alice/My Documents/a b.txt"].join("\n")
        );

        expect(files[0].name).toBe("/Users/alice/My Documents/a b.txt");
    });
});
