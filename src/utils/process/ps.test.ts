import { describe, expect, test } from "bun:test";
import {
    chunk,
    PS_BATCH_SIZE,
    parseOpenFileCounts,
    parsePsLine,
    parsePsList,
    processBasename,
} from "@genesiscz/utils/process/ps";

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
