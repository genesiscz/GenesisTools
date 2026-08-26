import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { captureDir } from "./lib/paths.ts";

/** The junior-proof CLI contract: every wrong invocation teaches the right one. */

function run(args: string[]): { code: number; text: string } {
    const r = Bun.spawnSync({
        cmd: ["bun", `${import.meta.dir}/index.ts`, ...args],
        stdout: "pipe",
        stderr: "pipe",
    });

    return { code: r.exitCode ?? 1, text: `${r.stdout.toString()}${r.stderr.toString()}` };
}

describe("record CLI", () => {
    test("exits 1 without a scope, names both scope flags, and writes no pidfile", () => {
        const r = run(["record", "--port", "59999"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("record needs a scope");
        expect(r.text).toContain("--match <url-substr>");
        expect(r.text).toContain("--all-tabs");
        expect(existsSync(join(captureDir(59999), "recorder.pid"))).toBe(false);
    });

    test("rejects an unknown capture channel and enumerates the vocabulary", () => {
        const r = run(["record", "--port", "59999", "--all-tabs", "--channels", "bogus"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("unknown capture channel(s): bogus");
        for (const channel of ["net", "console", "ws", "body", "storage"]) {
            expect(r.text).toContain(channel);
        }
    });
});

describe("watch tombstone", () => {
    test("explains the record/follow split and exits 1", () => {
        const r = run(["watch", "--channels", "nav"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("record");
        expect(r.text).toContain("follow");
        expect(r.text).toContain("har");
    });
});

describe("follow CLI", () => {
    test("rejects an unknown render channel and enumerates the vocabulary", () => {
        const r = run(["follow", "--port", "59999", "--channels", "nope"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("unknown render channel(s): nope");
        expect(r.text).toContain("redirect");
        expect(r.text).toContain("cookie");
    });

    test("with nothing to follow, points at record and attach", () => {
        const r = run(["follow", "--port", "59998", "--channels", "nav"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("nothing to follow");
        expect(r.text).toContain("record --port 59998 --all-tabs");
    });
});

describe("har CLI", () => {
    test("with no recorder and no buffer, teaches record / attach / --now", () => {
        const r = run(["har", "--port", "59997"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("nothing to dump");
        expect(r.text).toContain("record --port 59997 --all-tabs");
        expect(r.text).toContain("--now --reload");
    });

    test("rejects a malformed --last with the accepted forms", async () => {
        // --last is parsed only once a buffer exists, so plant a leftover
        // segment (no recorder → --from-buffer reaches the parser). The name
        // must match seg-<digits>.jsonl or segmentStats will not count it.
        const dir = captureDir(59996);
        const segment = join(dir, `seg-${Date.now()}.jsonl`);
        mkdirSync(dir, { recursive: true });
        await Bun.write(segment, "");
        try {
            const r = run(["har", "--port", "59996", "--from-buffer", "--last", "bananas"]);
            expect(r.code).toBe(1);
            expect(r.text).toContain("--last takes 90s / 30m / 2h");
            expect(r.text).toContain("'bananas'");
        } finally {
            // Remove ONLY the planted segment — a real capture on this port
            // (however unlikely) must survive the test.
            rmSync(segment, { force: true });
        }
    });
});

describe("scaffold CLI", () => {
    test("without a name lists every recipe and exits 1", () => {
        const r = run(["scaffold"]);
        expect(r.code).toBe(1);
        for (const recipe of [
            "redirect-chain",
            "cookie-diff",
            "storage-snapshot",
            "body-fetch",
            "console-trap",
            "blank",
        ]) {
            expect(r.text).toContain(recipe);
        }

        expect(r.text).toContain("scaffold needs a script name");
    });

    test("unknown recipe lists the valid ones", () => {
        const r = run(["scaffold", "myProbe", "--recipe", "nope"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("unknown recipe 'nope'");
        expect(r.text).toContain("redirect-chain");
    });
});

describe("help completeness", () => {
    // Per-verb markers: a flag or guidance line that only that verb's help
    // carries — a length check would pass on any truncated or generic help.
    const HELP_MARKERS: Record<string, string[]> = {
        record: ["--all-tabs", "Capture channels", "Examples:"],
        follow: ["Render channels", "--last <duration>", "Examples:"],
        har: ["--from-buffer", "Buffer dumps are metadata + headers", "Examples:"],
        cleanup: ["--stale <port...>", "--yes"],
        scaffold: ["--recipe <recipe>", "Recipes"],
        mcp: ["take_snapshot", "Examples:"],
        attach: ["read at browser STARTUP", "--port <n>"],
    };

    test("every verb's --help carries its own flags and guidance", () => {
        for (const [verb, markers] of Object.entries(HELP_MARKERS)) {
            const r = run([verb, "--help"]);
            expect(r.code).toBe(0);
            for (const marker of markers) {
                expect(r.text).toContain(marker);
            }
        }
    });
});
