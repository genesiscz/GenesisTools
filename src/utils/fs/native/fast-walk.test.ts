import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BulkReadCalls, bulkReadCalls, type FastWalkEntry, fastWalk, walkNative } from "./fast-walk";
import { libSystem } from "./libsystem";

const root = mkdtempSync(join(tmpdir(), "fast-walk-"));
const at = new Date("2026-10-01T10:00:00.000Z");

function file(relative: string, content = "{}\n"): void {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    utimesSync(path, at, at);
}

file("project-a/one.jsonl", "a".repeat(123));
file("project-a/notes.txt");
file("project-a/session-1/subagents/agent-1.jsonl");
file("project-b/two.jsonl");
file("project-b/deep/deeper/deepest/three.jsonl");
symlinkSync(join(root, "project-b"), join(root, "link-to-b"));
mkdirSync(join(root, "locked"));
chmodSync(join(root, "locked"), 0o000);

afterAll(() => {
    chmodSync(join(root, "locked"), 0o755);
    rmSync(root, { recursive: true, force: true });
});

function view(entries: FastWalkEntry[]): string[] {
    return entries
        .map((entry) => `${entry.kind} ${entry.path.slice(root.length)} ${entry.size}`)
        .sort((left, right) => left.localeCompare(right));
}

describe.each(["js", "native"] as const)("fastWalk (%s)", (engine) => {
    const skip = engine === "native" && process.platform !== "darwin";

    it.skipIf(skip)(
        "returns matching files at every depth with their size and mtime, and links unfollowed",
        async () => {
            const result = await fastWalk({ roots: [root], endsWith: [".jsonl"], engine });

            expect(result.engine).toBe(engine);
            expect(view(result.entries)).toEqual([
                "file /project-a/one.jsonl 123",
                "file /project-a/session-1/subagents/agent-1.jsonl 3",
                "file /project-b/deep/deeper/deepest/three.jsonl 3",
                "file /project-b/two.jsonl 3",
                "link /link-to-b 0",
            ]);
            expect(result.entries.find((entry) => entry.path.endsWith("one.jsonl"))?.mtimeMs).toBeCloseTo(
                at.getTime(),
                0
            );
            expect(result.errors.map((error) => error.path.slice(root.length))).toEqual(["/locked"]);
        }
    );

    it.skipIf(skip)("stops at maxDepth and matches exact names", async () => {
        const result = await fastWalk({ roots: [root], names: ["two.jsonl", "one.jsonl"], maxDepth: 1, engine });

        expect(view(result.entries.filter((entry) => entry.kind === "file"))).toEqual([
            "file /project-a/one.jsonl 123",
            "file /project-b/two.jsonl 3",
        ]);
    });

    it.skipIf(skip)("lists directories with their mtime when asked", async () => {
        const result = await fastWalk({
            roots: [root],
            names: ["none"],
            maxDepth: 1,
            includeDirectories: true,
            engine,
        });

        expect(view(result.entries.filter((entry) => entry.kind === "directory"))).toEqual([
            "directory /locked 0",
            "directory /project-a 0",
            "directory /project-a/session-1 0",
            "directory /project-b 0",
            "directory /project-b/deep 0",
        ]);
    });
});

describe.skipIf(!libSystem())("fastWalk on a filesystem without getattrlistbulk", () => {
    it("walks a folder that refuses bulk reads with readdir, with the same depth and name rules", async () => {
        const root = mkdtempSync(join(tmpdir(), "fast-walk-enotsup-"));
        mkdirSync(join(root, "local"), { recursive: true });
        mkdirSync(join(root, "share", "deep", "deeper"), { recursive: true });
        writeFileSync(join(root, "top.jsonl"), "{}\n");
        writeFileSync(join(root, "local", "a.jsonl"), "{}\n");
        writeFileSync(join(root, "share", "b.jsonl"), "{}\n");
        writeFileSync(join(root, "share", "skip.txt"), "x\n");
        writeFileSync(join(root, "share", "deep", "c.jsonl"), "{}\n");
        writeFileSync(join(root, "share", "deep", "deeper", "d.jsonl"), "{}\n");
        const real = libSystem();

        if (!real) {
            return;
        }

        const native = bulkReadCalls(real);
        const opened = new Map<number, string>();
        const refused = join(root, "share");
        let lastRefused = false;
        const fake: BulkReadCalls = {
            ...native,
            open: (path, flags) => {
                const fd = native.open(path, flags);
                opened.set(fd, path.toString("utf8", 0, path.length - 1));
                return fd;
            },
            getattrlistbulk: (fd, attributes, buffer, size, options) => {
                lastRefused = opened.get(fd) === refused;
                return lastRefused ? -1 : native.getattrlistbulk(fd, attributes, buffer, size, options);
            },
            errno: () => (lastRefused ? 45 : native.errno()),
        };
        const options = { roots: [root], names: [], endsWith: [".jsonl"], includeDirectories: false };
        const paths = (entries: FastWalkEntry[]) => entries.map((entry) => entry.path).sort();

        try {
            for (const maxDepth of [Number.POSITIVE_INFINITY, 2]) {
                const walked = await walkNative(fake, { ...options, maxDepth });
                const portable = await fastWalk({ ...options, maxDepth, engine: "js" });

                expect(walked.errors).toEqual([]);
                expect(paths(walked.entries)).toEqual(paths(portable.entries));
            }

            expect(paths((await walkNative(fake, { ...options, maxDepth: 2 })).entries)).not.toContain(
                join(root, "share", "deep", "deeper", "d.jsonl")
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
