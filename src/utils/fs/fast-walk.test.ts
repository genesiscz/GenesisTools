import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FastWalkEntry, fastWalk } from "./fast-walk";

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
            const result = await fastWalk({ roots: [root], names: ["*.jsonl"], engine });

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
