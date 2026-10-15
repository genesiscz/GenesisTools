import { describe, expect, spyOn, test } from "bun:test";
import { closeSync, existsSync, linkSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as linux from "./linux-proc";
import { openFiles, pidsByPath, pidsOf } from "./open-files";
import * as os from "./os";

const hasLsof = Bun.which("lsof") !== null || existsSync("/usr/sbin/lsof");

describe("openFiles", () => {
    test("an empty query is a clear answer, not an unknown one", () => {
        expect(openFiles({})).toEqual([]);
    });

    test("paths that do not exist are dropped rather than turned into an lsof error", () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        expect(openFiles({ files: [join(root, "absent")], directories: [join(root, "absent-dir")] })).toEqual([]);
    });

    test.skipIf(!hasLsof)("finds this process holding its own file open", () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        const path = join(root, "held.txt");
        writeFileSync(path, "held");
        const handle = openSync(path, "r");

        try {
            const result = openFiles({ files: [path] });
            expect(result).not.toBe("unknown");
            expect(Array.isArray(result) ? result.map((entry) => entry.pid) : []).toContain(process.pid);
        } finally {
            closeSync(handle);
        }
    });

    test.skipIf(process.platform !== "linux")("on Linux /proc answers, with no lsof started", async () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        const path = join(root, "held.txt");
        writeFileSync(path, "held");
        const handle = openSync(path, "r");
        const child = Bun.spawn(["sleep", "30"], { cwd: root, stdout: "ignore", stderr: "ignore", env: process.env });
        const spawned = spyOn(Bun, "spawnSync");

        try {
            const files = openFiles({ files: [path] });
            const tree = openFiles({ directories: [root] });

            expect(Array.isArray(files) ? files.map((entry) => entry.pid) : files).toContain(process.pid);
            // The child's working directory is inside the tree, as `lsof +D` lists it.
            expect(Array.isArray(tree) ? tree.map((entry) => entry.pid) : tree).toContain(child.pid);
            expect(spawned).not.toHaveBeenCalled();
        } finally {
            spawned.mockRestore();
            closeSync(handle);
            child.kill();
            await child.exited;
        }
    });

    test.skipIf(process.platform !== "linux")(
        "on Linux a hard link to the file asked for counts, as lsof counts it",
        () => {
            const root = mkdtempSync(join(tmpdir(), "open-files-"));
            const path = join(root, "cache.db");
            const alias = join(root, "cache-link.db");
            writeFileSync(path, "cache");
            linkSync(path, alias);
            const handle = openSync(alias, "r");

            try {
                const result = openFiles({ files: [path] });
                expect(Array.isArray(result) ? result.map((entry) => entry.pid) : result).toContain(process.pid);
            } finally {
                closeSync(handle);
            }
        }
    );

    describe("on Linux, when /proc cannot answer", () => {
        /** Runs `openFiles` for a real file with `/proc` replaced: the listed pids, what each one's descriptors give. */
        function ask(pids: number[], held: Record<number, linux.HeldFile[] | null>) {
            const root = mkdtempSync(join(tmpdir(), "open-files-proc-"));
            const path = join(root, "cache.db");
            writeFileSync(path, "cache");
            const platform = spyOn(os, "processPlatform").mockReturnValue("linux");
            const list = spyOn(linux, "listProcPids").mockReturnValue(pids);
            const files = spyOn(linux, "procHeldFiles").mockImplementation((pid) => held[pid] ?? null);
            const read = spyOn(linux, "readProcProcess").mockReturnValue(null);

            try {
                return openFiles({ files: [path] });
            } finally {
                platform.mockRestore();
                list.mockRestore();
                files.mockRestore();
                read.mockRestore();
            }
        }

        const self = process.pid;

        test("a /proc that lists nothing is unknown, not a clear answer", () => {
            expect(ask([], {})).toBe("unknown");
        });

        test("a /proc listing that lacks this process is unknown", () => {
            expect(ask([4242], { 4242: [] })).toBe("unknown");
        });

        test("this process's own descriptors being unreadable is unknown", () => {
            expect(ask([self, 4242], { [self]: null, 4242: [] })).toBe("unknown");
        });

        test("a process whose descriptors cannot be read is left out as lsof leaves it out, the rest still answer", () => {
            expect(ask([self, 4242, 4243], { [self]: [], 4242: null, 4243: null })).toEqual([]);
        });
    });

    test("a timeout is unknown, and exit 1 with no stderr is a clear empty answer", () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        const path = join(root, "file.txt");
        writeFileSync(path, "x");
        const spawn = spyOn(Bun, "spawnSync");

        try {
            spawn.mockReturnValueOnce({
                exitCode: null,
                stdout: Buffer.from(""),
                stderr: Buffer.from(""),
                success: false,
            } as unknown as ReturnType<typeof Bun.spawnSync>);
            expect(openFiles({ files: [path], timeoutMs: 15_000 })).toBe("unknown");
            expect(spawn.mock.calls[0]?.[1]).toMatchObject({ timeout: 15_000 });

            spawn.mockReturnValueOnce({
                exitCode: 1,
                stdout: Buffer.from(""),
                stderr: Buffer.from(""),
                success: false,
            } as unknown as ReturnType<typeof Bun.spawnSync>);
            expect(openFiles({ files: [path] })).toEqual([]);
            expect(pidsByPath("unknown")).toBeNull();
            expect(pidsOf("unknown")).toBeNull();
            expect(pidsByPath([])).toEqual(new Map());
            expect(pidsOf([])).toEqual([]);
            const handles = [{ pid: 7, command: "writer", path }];
            expect(pidsByPath(handles)?.get(path)).toEqual([7]);
            expect(
                pidsOf([
                    { pid: 7, command: "writer", path },
                    { pid: 7, command: "writer", path: `${path}.2` },
                ])
            ).toEqual([7]);
        } finally {
            spawn.mockRestore();
        }
    });

    test.skipIf(!hasLsof)("reports a clear result once the handle is closed", () => {
        const root = mkdtempSync(join(tmpdir(), "open-files-"));
        const path = join(root, "released.txt");
        writeFileSync(path, "released");
        closeSync(openSync(path, "r"));

        expect(openFiles({ files: [path] })).toEqual([]);
    });
});
