import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { computeSessionChanges, gitBlobOid } from "@genesiscz/utils/session-changes";
import {
    changeStatus,
    diffsFor,
    rawLogFiles,
    rawTransition,
    resolveSessionArgument,
    selectTurns,
    toolCallFiles,
} from "../../commands/changes";
import { fileDiff, readBlobs } from "./diff";
import {
    type ChangeEvent,
    commandEditsFiles,
    fileToolSource,
    lastTurnIds,
    recordChange,
    recordFileToolEdit,
    recordScriptedEdits,
    sessionChangesPath,
} from "./log";
import { gitObjectSink } from "./objects";

describe("the changes command, as the hub calls it", () => {
    test("a session with no log and no transcript, and --tool beside --tools, exit 1 with a reason", () => {
        // A scratch HOME: no transcript of the invented id can be found, and nothing real is written.
        const home = mkdtempSync(join(tmpdir(), "changes-cli-"));
        const { CLAUDE_CONFIG_DIR: _claude, ...inherited } = process.env;
        const childEnv = {
            ...inherited,
            HOME: home,
            GENESIS_TOOLS_HOME: home,
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
        };
        const run = (...args: string[]) =>
            spawnSync("bun", [join(import.meta.dir, "..", "..", "index.ts"), "changes", ...args], {
                encoding: "utf8",
                env: childEnv,
                timeout: 20_000,
            });

        const unknown = run("00000000-0000-4000-8000-00000000abcd", "--json");
        expect({ status: unknown.status, stdout: unknown.stdout }).toEqual({ status: 1, stdout: "" });
        expect(unknown.stderr).toContain("No change log and no transcript");

        const both = run("00000000-0000-4000-8000-00000000abcd", "--tool", "toolu_a", "--tools", "toolu_b", "--json");
        expect(both.status).toBe(1);
        expect(both.stderr).toContain("--tool and --tools cannot be combined");

        const raw = run("00000000-0000-4000-8000-00000000abcd", "--raw", "--tools", "toolu_b", "--json");
        expect(raw.status).toBe(1);
        expect(raw.stderr).toContain("--raw takes one call");
    });
});

describe("the session argument", () => {
    const full = "7399934a-6a92-4ee1-bb4c-3f8694fb42bf";
    const match = { sessionId: full, providerId: "claude", title: "agents-window", mtime: 0 };

    test("a leading part of an id is completed from the index, and says so", () => {
        expect(resolveSessionArgument("7399934a", () => ({ kind: "unique", sessionId: full, match }))).toEqual({
            id: full,
            note: `7399934a is session ${full}`,
        });
    });

    test("a full id, or one the index cannot see, is used as given", () => {
        expect(resolveSessionArgument(full, () => ({ kind: "exact", sessionId: full }))).toEqual({ id: full });
        expect(resolveSessionArgument("s-x", () => ({ kind: "unavailable", sessionId: "s-x" }))).toEqual({ id: "s-x" });
        expect(resolveSessionArgument("s-x", () => ({ kind: "none" }))).toEqual({ id: "s-x" });
    });

    test("an ambiguous prefix is refused with the candidates, never guessed", () => {
        const other = { sessionId: "7399934a-0000-4000-8000-000000000000", providerId: "codex", title: null, mtime: 0 };
        const result = resolveSessionArgument("7399934a", () => ({ kind: "ambiguous", candidates: [match, other] }));
        expect("error" in result && result.error).toContain("more than one session");
        expect("error" in result && result.error).toContain(other.sessionId);
    });
});

describe("session change log path", () => {
    test("a session id that is not one plain segment is refused", () => {
        expect(sessionChangesPath("sess-9")).toEndWith(join("agents", "sess-9", "changes.jsonl"));

        for (const bad of ["../../x", "a/b", "..", "", "."]) {
            expect(() => sessionChangesPath(bad)).toThrow(/not a session id/);
        }
    });
});

describe("last turns", () => {
    test("the last N turns in log order, a turn counted where it last wrote", () => {
        const rows = [{ turn: "t1" }, { turn: "t2" }, { turn: "t1" }, { turn: "t3" }];
        expect(lastTurnIds(rows, 1)).toEqual(["t3"]);
        expect(lastTurnIds(rows, 2)).toEqual(["t1", "t3"]);
        expect(lastTurnIds(rows, 9)).toEqual(["t2", "t1", "t3"]);
        expect(lastTurnIds([], 3)).toEqual([]);
    });
});

describe("batched hashing", () => {
    test("one call's blobs go through hashAll once; per-blob hash is only the fallback", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-batch-"));
        const file = join(dir, "changes.jsonl");
        const a = join(dir, "a.ts");
        const b = join(dir, "b.ts");
        writeFileSync(a, "a2");
        writeFileSync(b, "b2");
        const batches: number[] = [];
        const single: string[] = [];
        const sink = {
            hash: (bytes: Buffer) => {
                single.push(bytes.toString("utf8"));
                return `one:${bytes.toString("utf8")}`;
            },
            hashAll: (blobs: Buffer[]) => {
                batches.push(blobs.length);
                return blobs.map((bytes) => `all:${bytes.toString("utf8")}`);
            },
            log: () => undefined,
        };

        recordScriptedEdits(
            file,
            `perl -pi -e 's/1/2/' ${a} ${b}`,
            { provider: "claude", session: "s1", turn: "t1", tool: "Bash", cwd: dir },
            [
                { path: a, before: Buffer.from("a1"), after: Buffer.from("a2") },
                { path: b, before: Buffer.from("b1"), after: Buffer.from("b2") },
            ],
            sink
        );

        const rows = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line) as { beforeOid: string; afterOid: string });
        expect(batches).toEqual([4]);
        expect(single).toEqual([]);
        expect(rows.map((row) => [row.beforeOid, row.afterOid])).toEqual([
            ["all:a1", "all:a2"],
            ["all:b1", "all:b2"],
        ]);
    });

    test("the git store's batch gives the same ids as one blob at a time", () => {
        const sink = gitObjectSink(join(mkdtempSync(join(tmpdir(), "changes-objects-")), "objects.git"));
        const blobs = [Buffer.from("alpha\n"), Buffer.from("beta\n")];

        expect(sink.hashAll?.(blobs)).toEqual(blobs.map((bytes) => sink.hash(bytes)));
    });
});

describe("recordChange", () => {
    test("identical content hashes once and a sink error is not thrown", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-"));
        const file = join(dir, "changes.jsonl");
        const hashes: string[] = [];
        const logs: string[] = [];
        const sink = {
            hash: (bytes: Buffer) => {
                const id = bytes.toString("utf8");
                if (!hashes.includes(id)) {
                    hashes.push(id);
                }
                return id;
            },
            log: (line: string) => logs.push(line),
        };
        const base = {
            provider: "claude",
            session: "s1",
            turn: "t1",
            tool: "Edit",
            cwd: "/tmp",
            path: "a.ts",
            source: "edit" as const,
        };
        recordChange(file, base, { before: Buffer.from("a"), after: Buffer.from("b") }, sink);
        recordChange(file, base, { before: Buffer.from("a"), after: Buffer.from("b") }, sink);
        recordChange(file, base, { before: Buffer.alloc(2_000_001), after: Buffer.from("c") }, sink);
        recordChange(
            file,
            base,
            { before: Buffer.from("boom") },
            {
                hash: () => {
                    throw new Error("boom");
                },
                log: (line: string) => logs.push(line),
            }
        );

        const rows = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line) as ChangeEvent);
        expect(hashes).toEqual(["a", "b", "c"]);
        // Only the before side was too large: the after side keeps its oid, and each side says so.
        expect(rows[2]).toMatchObject({ skipped: "large", beforeSkipped: "large", beforeOid: null, afterOid: "c" });
        expect(rows[2]?.afterSkipped).toBeUndefined();
        expect(rawLogFiles(rows.slice(2, 3)).map(rawTransition)).toEqual(["large -> c"]);
        expect(logs.some((line) => line.includes("boom"))).toBe(true);
    });

    test("a row from before the per-side fields still prints its one skip reason", () => {
        const legacy: ChangeEvent = {
            ts: "2026-09-20T10:00:00Z",
            provider: "claude",
            session: "s1",
            turn: "t1",
            tool: "Edit",
            cwd: "/tmp",
            path: "a.ts",
            beforeOid: null,
            afterOid: "c",
            source: "edit",
            skipped: "binary",
        };

        expect(rawLogFiles([legacy]).map(rawTransition)).toEqual(["binary"]);
        expect(rawLogFiles([{ ...legacy, skipped: undefined }]).map(rawTransition)).toEqual(["- -> c"]);
    });

    test("a null byte is recorded as binary and not hashed", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-"));
        const file = join(dir, "changes.jsonl");
        const hashed: Buffer[] = [];
        recordChange(
            file,
            { provider: "claude", session: "s1", turn: "t1", tool: "Bash", cwd: dir, path: "a.bin", source: "bash" },
            { before: Buffer.from([0, 1, 2]) },
            {
                hash: (bytes) => {
                    hashed.push(bytes);
                    return "nope";
                },
                log: () => undefined,
            }
        );
        const row = SafeJSON.parse(readFileSync(file, "utf8").trim()) as { skipped?: string; beforeOid: string | null };
        expect(row.skipped).toBe("binary");
        expect(row.beforeOid).toBeNull();
        expect(hashed).toHaveLength(0);
    });
});

describe("file tools", () => {
    test("an Edit keeps the text before the call and a Write that created the file has no before", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-"));
        const file = join(dir, "changes.jsonl");
        const edited = join(dir, "a.ts");
        const created = join(dir, "b.ts");
        writeFileSync(edited, "after");
        writeFileSync(created, "new");
        const sink = { hash: (bytes: Buffer) => `oid:${bytes.toString("utf8")}`, log: () => undefined };
        const base = { provider: "claude", session: "s1", turn: "t1", cwd: dir };

        recordFileToolEdit(file, { ...base, tool: "Edit", path: edited }, "before", sink);
        recordFileToolEdit(file, { ...base, tool: "Write", path: created }, null, sink);
        recordFileToolEdit(file, { ...base, tool: "Read", path: edited }, "before", sink);

        const rows = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line) as { source: string; beforeOid: string | null; afterOid: string });
        expect(rows.map((row) => [row.source, row.beforeOid, row.afterOid])).toEqual([
            ["edit", "oid:before", "oid:after"],
            ["write", null, "oid:new"],
        ]);
        expect(fileToolSource("MultiEdit")).toBe("edit");
        expect(fileToolSource("Bash")).toBeNull();
    });
});

describe("scripted editors", () => {
    test("a named file with no change since the command began is not logged", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-script-"));
        const file = join(dir, "changes.jsonl");
        const input = join(dir, "in.csv");
        const output = join(dir, "out.csv");
        writeFileSync(input, "a,b\n");
        writeFileSync(output, "b,a\n");
        utimesSync(input, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
        const sink = { hash: (bytes: Buffer) => bytes.toString("utf8"), log: () => undefined };
        const event = { provider: "claude", session: "s1", turn: "t1", tool: "Bash", cwd: dir };
        const command = `python3 transform.py ${input} > ${output}`;

        recordScriptedEdits(file, command, { ...event, since: Date.parse("2026-06-01T00:00:00Z") }, [], sink);
        recordScriptedEdits(file, command, event, [], sink);

        const rows = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line) as { path: string });
        expect(rows.map((row) => row.path)).toEqual([output]);
    });

    test("a named path another chunk of the same command records is not logged twice", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-script-"));
        const file = join(dir, "changes.jsonl");
        const output = join(dir, "out.csv");
        writeFileSync(output, "b,a\n");
        const sink = { hash: (bytes: Buffer) => bytes.toString("utf8"), log: () => undefined };
        const event = { provider: "claude", session: "s1", turn: "t1", tool: "Bash", cwd: dir };
        const command = `python3 transform.py in.csv > ${output}`;
        const since = Date.now() - 60_000;

        recordScriptedEdits(file, command, { ...event, since, known: new Set([output]) }, [], sink);
        expect(existsSync(file)).toBe(false);

        recordScriptedEdits(file, command, { ...event, since }, [], sink);
        expect(readJsonlRows<ChangeEvent>(file).rows.map((row) => row.path)).toEqual([output]);
    });

    test("delete, move, copy, working-tree git verbs and formatter writes are edits; a mention is not", () => {
        for (const writes of [
            "rm -f a.ts",
            "mv a.ts b.ts",
            "cp a.ts b.ts",
            "git checkout -- a.ts",
            "git -C repo stash pop",
            "git apply fix.patch",
            "bunx prettier --write src",
            "bunx biome check --write src/a.ts",
            "eslint --fix src",
            "gofmt -w main.go",
            "ruff format .",
            "cd src && rm old.ts",
            "patch -p1 < fix.diff",
            "echo done | tee out.txt",
        ]) {
            expect([writes, commandEditsFiles(writes)]).toEqual([writes, true]);
        }

        for (const reads of [
            "echo rm a.ts",
            "grep -rn checkout src",
            "git status",
            "git log --oneline",
            "git diff --patch",
            "git show --patch HEAD",
            "rg -n tee src",
            "bunx biome check src",
            "prettier --check src",
            "gofmt -l .",
        ]) {
            expect([reads, commandEditsFiles(reads)]).toEqual([reads, false]);
        }
    });

    test("python is an edit when it runs a script or writes, not because the interpreter is named", () => {
        for (const writes of [
            "python3 tools/rename.py src",
            "cd repo && python3 -u edit.py a.ts",
            `python3 -c "open('a.ts', 'w').write('x')"`,
            `python3 -c "import os; os.remove('a.ts')"`,
            "python3 - <<'EOF'\nfrom pathlib import Path\nPath('a.ts').write_text('x')\nEOF",
            "python -m black src",
            `python3 -c "print(1)" > out.txt`,
        ]) {
            expect([writes, commandEditsFiles(writes)]).toEqual([writes, true]);
        }

        for (const reads of [
            "python3 --version",
            "python -m pytest tests",
            `python3 -c "print(open('a.ts').read())"`,
            "python3 - <<'EOF'\nprint(sum(range(3)))\nEOF",
            "rg -n python src",
            "which python3",
        ]) {
            expect([reads, commandEditsFiles(reads)]).toEqual([reads, false]);
        }
    });

    test("an arrow, a descriptor dup, a discard, or grep -i after sed is not an edit", () => {
        expect(commandEditsFiles(`echo "a -> b" && node -e "x => x"`)).toBe(false);
        expect(commandEditsFiles("bun test 2>&1 | tail -5")).toBe(false);
        expect(commandEditsFiles("git fetch >/dev/null 2>&1")).toBe(false);
        expect(commandEditsFiles("sed -n 's/x/y/p' f.ts | grep -i z")).toBe(false);
        expect(commandEditsFiles("perl -pi -e 's/a/b/' f.ts")).toBe(true);
        expect(commandEditsFiles("bun build.ts 2> err.log")).toBe(true);
        expect(commandEditsFiles("cat a.ts >> b.ts")).toBe(true);
    });

    test("fable-replace and python writes are logged; a read-only command is not", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-script-"));
        const file = join(dir, "changes.jsonl");
        const target = join(dir, "a.ts");
        writeFileSync(target, "after\n");
        const sink = {
            hash: (bytes: Buffer) => bytes.toString("utf8"),
            log: () => undefined,
        };
        const event = { provider: "claude", session: "s1", turn: "t1", tool: "Bash", cwd: dir };

        recordScriptedEdits(
            file,
            "git status",
            event,
            [{ path: target, before: Buffer.from("a"), after: Buffer.from("b") }],
            sink
        );
        recordScriptedEdits(file, 'python3 -c "print(1)"', event, [], sink);
        recordScriptedEdits(
            file,
            "bun /tmp/fable-replace/scripts/cli.ts apply",
            event,
            [{ path: target, before: Buffer.from("before\n"), after: Buffer.from("after\n") }],
            sink
        );
        recordScriptedEdits(
            file,
            `python3 ${join(dir, "edit.py")} ${target}`,
            { ...event, since: Date.now() - 60_000 },
            [],
            sink
        );

        const rows = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line) as { path: string; source: string; beforeOid: string | null });

        expect(commandEditsFiles("git status")).toBe(false);
        expect(commandEditsFiles("sed -i 's/a/b/' file.ts")).toBe(true);
        expect(rows.map((row) => row.source)).toEqual(["bash", "bash"]);
        expect(rows.every((row) => row.path === target)).toBe(true);
        expect(rows[0]?.beforeOid).toBe("before\n");
    });
});

describe("per-call rows and diffs", () => {
    test("a fable-replace edit through Bash is logged under that call's toolUseId; a read-only call logs nothing", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-tool-"));
        const file = join(dir, "changes.jsonl");
        const target = join(dir, "a.ts");
        writeFileSync(target, "after\n");
        const sink = { hash: (bytes: Buffer) => bytes.toString("utf8"), log: () => undefined };
        const event = { provider: "claude", session: "s1", turn: "turn-1", tool: "Bash", cwd: dir };
        const touched = [{ path: target, before: Buffer.from("before\n"), after: Buffer.from("after\n") }];

        recordScriptedEdits(file, "git diff", { ...event, toolUseId: "toolu_read" }, touched, sink);
        recordScriptedEdits(
            file,
            "bun /tmp/fable-replace/scripts/cli.ts apply",
            { ...event, toolUseId: "toolu_fable" },
            touched,
            sink
        );

        const rows = readJsonlRows<ChangeEvent>(file).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ toolUseId: "toolu_fable", turn: "turn-1" });
        expect(rawLogFiles(rows).map((row) => row.toolUseIds)).toEqual([["toolu_fable"]]);
    });

    test("an Edit hashes its before and after in one batch", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-edit-batch-"));
        const file = join(dir, "changes.jsonl");
        const edited = join(dir, "a.ts");
        writeFileSync(edited, "after");
        const batches: number[] = [];
        const sink = {
            hash: (): string => {
                throw new Error("one blob at a time is the slow path");
            },
            hashAll: (blobs: Buffer[]) => {
                batches.push(blobs.length);
                return blobs.map((bytes) => `oid:${bytes.toString("utf8")}`);
            },
            log: () => undefined,
        };

        recordFileToolEdit(
            file,
            {
                provider: "claude",
                session: "s1",
                turn: "t1",
                tool: "Edit",
                toolUseId: "toolu_e",
                cwd: dir,
                path: edited,
            },
            "before",
            sink
        );

        expect(batches).toEqual([2]);
        expect(SafeJSON.parse(readFileSync(file, "utf8").trim())).toMatchObject({
            beforeOid: "oid:before",
            afterOid: "oid:after",
            toolUseId: "toolu_e",
        });
    });

    test("a file diff is git-shaped, counts its lines, and names created, deleted and binary files", () => {
        const edit = fileDiff({ path: "src/a.ts", before: Buffer.from("one\ntwo\n"), after: Buffer.from("one\n2\n") });

        expect(edit).toMatchObject({ added: 1, removed: 1 });
        expect(edit.diff).toStartWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@");
        expect(fileDiff({ path: "n.ts", before: null, after: Buffer.from("x\n") }).diff).toStartWith(
            "--- /dev/null\n+++ b/n.ts"
        );
        expect(fileDiff({ path: "d.ts", before: Buffer.from("x\n"), after: null }).diff).toContain("+++ /dev/null");
        expect(fileDiff({ path: "b.bin", before: Buffer.from([0, 1]), after: Buffer.from([0, 2]) })).toEqual({
            diff: null,
            reason: "binary",
        });
        expect(fileDiff({ path: "u.ts", before: undefined, after: Buffer.from("x") })).toEqual({
            diff: null,
            reason: "missing-blob",
        });
    });

    test("a pathological file past the budget gets no diff instead of a stall", () => {
        const lines = (seed: number) =>
            Array.from({ length: 20_000 }, (_, index) => `${(index * seed) % 997}`).join("\n");

        expect(
            fileDiff({ path: "big.txt", before: Buffer.from(lines(7)), after: Buffer.from(lines(13)), budgetMs: 1 })
        ).toEqual({ diff: null, reason: "budget" });
    });

    test("an unknown after-state is modified with no diff, never a deletion of the whole file", () => {
        const before = Buffer.from("line\n".repeat(20));
        const oid = "b".repeat(40);
        const unknownAfter = { path: "/repo/a.ts", beforeOid: oid };

        expect(changeStatus(unknownAfter)).toBe("modified");
        expect(diffsFor([unknownAfter], new Map([[oid, before]])).get("/repo/a.ts")).toEqual({
            diff: null,
            reason: "missing-blob",
        });
        expect(changeStatus({ beforeOid: oid, afterOid: null })).toBe("deleted");
        expect(changeStatus({ beforeOid: null, afterOid: oid })).toBe("added");
    });

    test("--tool reads the call's own turn, not the whole session merged", () => {
        const file = (toolUseIds: string[]) => ({
            path: "/repo/a.ts",
            via: "edit" as const,
            confidence: "exact" as const,
            toolUseIds,
        });
        const turns = [
            { turnId: "t1", index: 0, at: null, files: [file(["toolu_old"])], excluded: [] },
            { turnId: "t2", index: 1, at: null, files: [file(["toolu_fable"])], excluded: [] },
        ];

        expect(selectTurns([], turns, { tool: "toolu_fable" })?.map((turn) => turn.turnId)).toEqual(["t2"]);
        expect(selectTurns([], turns, {})).toBeNull();
    });

    test("--tools answers each call from one loaded session the way --tool answers it alone", () => {
        const file = (path: string, toolUseIds: string[]) => ({
            path,
            via: "edit" as const,
            confidence: "exact" as const,
            toolUseIds,
        });
        const turns = [
            { turnId: "t1", index: 0, at: null, files: [file("/repo/a.ts", ["toolu_a"])], excluded: [] },
            {
                turnId: "t2",
                index: 1,
                at: null,
                files: [file("/repo/b.ts", ["toolu_b"]), file("/repo/c.ts", ["toolu_c"])],
                excluded: [
                    {
                        path: "/repo/dist/b.js",
                        reason: "build-output" as const,
                        via: "bash" as const,
                        toolUseIds: ["toolu_b"],
                    },
                ],
            },
        ];
        const changes = { turns, files: turns.flatMap((turn) => turn.files) };

        expect(toolCallFiles(changes, "toolu_a").files.map((item) => item.path)).toEqual(["/repo/a.ts"]);
        expect(toolCallFiles(changes, "toolu_c").files.map((item) => item.path)).toEqual(["/repo/c.ts"]);
        expect(toolCallFiles(changes, "toolu_none").files).toEqual([]);
        // One turn, two calls: the exclusion belongs to toolu_b only, never to its neighbour.
        expect(toolCallFiles(changes, "toolu_b").excluded.map((item) => item.path)).toEqual(["/repo/dist/b.js"]);
        expect(toolCallFiles(changes, "toolu_c").excluded).toEqual([]);
    });

    test("a call the hook logged is found by --tool and --tools when no transcript call explains the row", () => {
        const dir = mkdtempSync(join(tmpdir(), "changes-seam-"));
        const file = join(dir, "changes.jsonl");
        const edited = join(dir, "a.ts");
        const scripted = join(dir, "b.ts");
        writeFileSync(edited, "after\n");
        writeFileSync(scripted, "sed after\n");
        const sink = { hash: (bytes: Buffer) => gitBlobOid(bytes), log: () => undefined };
        const base = { provider: "claude", session: "s-seam", turn: "prompt-1", cwd: dir };

        recordFileToolEdit(file, { ...base, tool: "Edit", toolUseId: "toolu_edit", path: edited }, "before\n", sink);
        recordScriptedEdits(
            file,
            `sed -i 's/x/y/' ${scripted}`,
            { ...base, tool: "Bash", toolUseId: "toolu_sed" },
            [{ path: scripted, before: Buffer.from("sed before\n"), after: Buffer.from("sed after\n") }],
            sink
        );
        const log = readJsonlRows<ChangeEvent>(file).rows;

        // No transcript (a session from another machine), and a transcript that has not flushed
        // the Bash call yet (the hub asks right after the call returns): the log's own id decides.
        // The scratch dir sits in the OS temp dir, which the path rules would exclude.
        const rules = { home: "/home/fixture", tempDirs: [], repoRoot: () => dir };
        const logOnly = computeSessionChanges({ sessionId: "s-seam", transcript: null, log, ...rules });
        const unflushed = computeSessionChanges({
            sessionId: "s-seam",
            transcript: { sessionId: "s-seam", turns: [], calls: [], cwds: [dir] },
            log,
            ...rules,
        });

        for (const changes of [logOnly, unflushed]) {
            expect(toolCallFiles(changes, "toolu_sed").files.map((item) => item.path)).toEqual([scripted]);
            expect(changes.files.flatMap((item) => item.toolUseIds)).not.toContain("");
        }

        expect(toolCallFiles(logOnly, "toolu_edit").files.map((item) => item.path)).toEqual([edited]);
    });

    test("blobs come back from the object store in one cat-file batch; an unknown oid is absent", () => {
        const store = join(mkdtempSync(join(tmpdir(), "changes-objects-")), "_objects");
        const sink = gitObjectSink(store);
        const [one, two] = sink.hashAll?.([Buffer.from("one\n"), Buffer.from("two\n")]) ?? [];
        const found = readBlobs([one ?? "", two ?? "", "0".repeat(40)], store);

        expect(found.get(one ?? "")?.toString()).toBe("one\n");
        expect(found.get(two ?? "")?.toString()).toBe("two\n");
        expect(found.size).toBe(2);
    });

    test("more blobs than one cat-file chunk holds all come back, merged across the chunks", () => {
        const store = join(mkdtempSync(join(tmpdir(), "changes-objects-")), "_objects");
        const blobs = Array.from({ length: 70 }, (_, index) => Buffer.from(`blob ${index}\n`));
        const oids = gitObjectSink(store).hashAll?.(blobs) ?? [];
        const found = readBlobs(oids, store);

        expect(found.size).toBe(70);
        expect(found.get(oids[69] ?? "")?.toString()).toBe("blob 69\n");
    });
});
