import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    analyzeCommand,
    applyReplacement,
    computeSessionChanges,
    type ExclusionReason,
    expandVariables,
    fableSpecPaths,
    gitBlobOid,
    type LoggedChange,
    lastChangedTurns,
    mergeTurnFiles,
    parseClaudeTranscript,
    parseCodexRollout,
    pathExclusion,
    type SessionChangesInput,
    type StageKind,
    storeBlobs,
} from "./index";

const REPO = "/tmp/fixture-repo";
const OTHER = "/tmp/fixture-other";
const HOME = "/home/fixture";
const TEMP = "/scratch-tmp";

const repoRoot = (dir: string): string | null => {
    if (dir === REPO || dir.startsWith(`${REPO}/`)) {
        return REPO;
    }

    return dir === OTHER || dir.startsWith(`${OTHER}/`) ? OTHER : null;
};

const analyze = (command: string, cwd = REPO, files?: Map<string, string>) => analyzeCommand({ command, cwd, files });

/** Seconds past a fixed instant, as the ISO text transcripts and the change log carry. */
const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 2, 10, 0, 0) + seconds * 1000).toISOString();

type Line = Record<string, unknown>;

function prompt(promptId: string, text: string, seconds: number): Line {
    return {
        type: "user",
        promptId,
        uuid: `msg-${promptId}`,
        timestamp: at(seconds),
        cwd: REPO,
        message: { role: "user", content: text },
    };
}

function use(id: string, name: string, input: Record<string, unknown>, seconds: number): Line {
    return {
        type: "assistant",
        timestamp: at(seconds),
        cwd: REPO,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    };
}

function result(
    promptId: string,
    id: string,
    seconds: number,
    extra: { toolUseResult?: unknown; isError?: boolean } = {}
): Line {
    return {
        type: "user",
        promptId,
        timestamp: at(seconds),
        cwd: REPO,
        message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, is_error: extra.isError === true }],
        },
        toolUseResult: extra.toolUseResult,
    };
}

function jsonl(lines: Line[]): string {
    return lines.map((line) => SafeJSON.stringify(line, { strict: true })).join("\n");
}

function row(turn: string, path: string, seconds: number, extra: Partial<LoggedChange> = {}): LoggedChange {
    return {
        ts: at(seconds),
        session: "fixture-session",
        turn,
        tool: "Bash",
        cwd: REPO,
        path,
        beforeOid: null,
        afterOid: null,
        source: "bash",
        ...extra,
    };
}

function compute(input: Omit<SessionChangesInput, "sessionId">) {
    return computeSessionChanges({
        sessionId: "fixture-session",
        home: HOME,
        tempDirs: [TEMP],
        repoRoot,
        isDirectory: () => false,
        ...input,
    });
}

describe("analyzeCommand", () => {
    it("names redirect, tee, sed -i (GNU and BSD) and perl -pi targets, relative to the cd target", () => {
        const analysis = analyze(
            "cd sub && echo x > out.txt && cat a | tee b.txt && sed -i '' 's/a/b/' c.ts && sed -i 's/a/b/' d.ts && perl -pi -e 's/a/b/' e.ts 2>&1 >/dev/null"
        );

        expect(analysis.writes).toEqual(
            ["out.txt", "b.txt", "c.ts", "d.ts", "e.ts"].map((name) => `${REPO}/sub/${name}`)
        );
        expect(analysis.workDirs).toEqual([`${REPO}/sub`]);
        expect(analysis.writesUnnamed).toBe(false);
    });

    it("reads fable-replace targets from its heredoc spec, not from block bodies that look like headers", () => {
        const command = [
            "bun plugins/fable-replace/scripts/cli.ts --cwd sub <<'FRSPEC'",
            "@@ a.ts",
            "<<<",
            "@@ not-a-target.ts",
            "===",
            "x",
            ">>>",
            "@@ b.ts",
            "<<< move to=c.ts symbol=moved",
            ">>>",
            "FRSPEC",
        ].join("\n");
        const analysis = analyze(command);

        expect(fableSpecPaths("@@ a.ts\n<<<\n@@ inside.ts\n>>>\n@@ b.ts\n")).toEqual(["a.ts", "b.ts"]);
        expect(analysis.writes).toEqual([`${REPO}/sub/a.ts`, `${REPO}/sub/b.ts`, `${REPO}/sub/c.ts`]);
        expect(analysis.writesUnnamed).toBe(false);
    });

    it("follows a --spec file a heredoc wrote, in the same command or an earlier one", () => {
        const same = analyze(
            "cat > spec.txt <<'EOF'\n@@ src/a.ts\n<<<\nx\n===\ny\n>>>\nEOF\nbun fable-replace/cli.ts --spec spec.txt"
        );
        expect(same.writes).toContain(`${REPO}/src/a.ts`);

        const files = new Map<string, string>();
        analyze(`cat > ${TEMP}/next.spec <<'EOF'\n@@ src/b.ts\n<<<\nx\n===\ny\n>>>\nEOF`, REPO, files);
        const later = analyze(`bun fable-replace/cli.ts --spec ${TEMP}/next.spec`, REPO, files);
        expect(later.writes).toEqual([`${REPO}/src/b.ts`]);

        const unknown = analyze(`bun fable-replace/cli.ts --spec ${TEMP}/never-seen.spec`);
        expect(unknown.writes).toEqual([]);
        expect(unknown.writesUnnamed).toBe(true);
    });

    it("expands variables the command assigns and for-loop items, and leaves other expansions unnamed", () => {
        expect(analyze("F=src/a.ts && sed -i 's/x/y/' \"$F\"").writes).toEqual([`${REPO}/src/a.ts`]);
        expect(analyze("for f in a.ts b.ts; do sed -i 's/x/y/' \"$f\"; done").writes).toEqual([
            `${REPO}/a.ts`,
            `${REPO}/b.ts`,
        ]);
        expect(expandVariables("$D/x.ts", new Map([["D", ["one", "two"]]]))).toEqual(["one/x.ts", "two/x.ts"]);
        expect(expandVariables("$UNSET/x.ts", new Map())).toBeNull();

        const unknown = analyze("sed -i 's/x/y/' \"$UNSET\"");
        expect(unknown.writes).toEqual([]);
        expect(unknown.writesUnnamed).toBe(true);

        const substituted = analyze("bunx biome check --write $(git diff --name-only -- '*.ts')");
        expect(substituted.writes).toEqual([]);
        expect(substituted.writesUnnamed).toBe(true);
    });

    it("reads the command xargs runs with its own flags, past the options of xargs", () => {
        for (const command of [
            "rg -l foo | xargs sed -i 's/a/b/'",
            "rg -l foo | xargs -I {} sed -i '' 's/a/b/' {}",
            "fd -e ts | xargs -n 1 prettier --write",
            "fd -e ts | xargs -0 -P 4 biome format --write",
        ]) {
            expect({ command, writesUnnamed: analyze(command).writesUnnamed }).toEqual({
                command,
                writesUnnamed: true,
            });
        }

        // Negative control: a reader behind xargs stays a read.
        const read = analyze("fd -e ts | xargs -n 1 wc -l");
        expect(read.writesUnnamed).toBe(false);
        expect(read.kinds).toEqual(["read", "read"]);
    });

    it("reads eval, osascript, plutil edits and gh downloads as possible writers, and their read forms as reads", () => {
        const cases: [string, boolean][] = [
            ["eval \"sed -i 's/a/b/' f\"", true],
            ["osascript -e 'do shell script \"touch f\"'", true],
            ["plutil -replace CFBundleVersion -string 2 Info.plist", true],
            ["plutil -extract CFBundleVersion raw Info.plist", true],
            ["gh release download v1", true],
            ["gh run download 12", true],
            ["plutil -p Info.plist", false],
            ["plutil -extract CFBundleVersion raw -o - Info.plist", false],
            ["gh pr view 12", false],
        ];

        for (const [command, writes] of cases) {
            expect({ command, writesUnnamed: analyze(command).writesUnnamed }).toEqual({
                command,
                writesUnnamed: writes,
            });
        }
    });

    it("never reads a heredoc body or a zsh array's items as shell words", () => {
        const python = analyze("python3 - <<'PY'\nrender = (hook) => x > out.ts\nprint(1)\nPY");
        expect(python.writes).toEqual([]);
        expect(python.kinds).toEqual(["read"]);

        expect(analyze("F=(src/a.ts src/b.ts) && echo $F").writes).toEqual([]);
    });

    it("classifies git verbs: a rewrite of the tree, a named restore, or a read", () => {
        const cases: [string, StageKind, string[]][] = [
            ["git checkout -m other-branch", "git-rewrite", []],
            ["git -C sub rebase origin/main", "git-rewrite", []],
            ["git stash", "git-rewrite", []],
            ["git commit -m x", "git-rewrite", []],
            ["git checkout -- a.ts", "write", [`${REPO}/a.ts`]],
            ["git restore --staged a.ts", "write", [`${REPO}/a.ts`]],
            ["git stash list", "read", []],
            ["git status --short", "read", []],
            ["git add a.ts", "read", []],
        ];

        for (const [command, kind, writes] of cases) {
            const analysis = analyze(command);
            expect({ command, kinds: analysis.kinds, writes: analysis.writes }).toEqual({
                command,
                kinds: [kind],
                writes,
            });
        }

        expect(analyze("git rm -r old").dirs).toEqual([`${REPO}/old`]);
        expect(analyze("git apply fix.patch").writesUnnamed).toBe(true);
    });

    it("classifies tests, builds, installs, scripts and read-only commands", () => {
        const cases: [string, StageKind][] = [
            ["bun run test src/a", "test"],
            ["bun test", "test"],
            ["bun scripts/selftest.ts", "test"],
            ["bunx tsgo --noEmit", "read"],
            ["bun run app", "build"],
            ["swift build -c release", "build"],
            ["bun add zod", "install"],
            ["rg -n foo src", "read"],
            ['python3 -c "print(1)"', "read"],
            ["bun scripts/ci/check-boundaries.ts", "read"],
            ["tools say done", "read"],
            ["tools github merge --rebase 12", "git-rewrite"],
            ["bun scripts/codemod.ts src/a.ts", "write"],
        ];

        for (const [command, kind] of cases) {
            expect({ command, kinds: analyze(command).kinds }).toEqual({ command, kinds: [kind] });
        }

        expect(analyze("bun add zod").installs).toBe(true);
        expect(analyze("bun test -u").updatesSnapshots).toBe(true);

        const codemod = analyze("bun scripts/codemod.ts src/a.ts");
        expect(codemod.writesUnnamed).toBe(true);
        expect(codemod.hints).toEqual([`${REPO}/src/a.ts`]);

        const inline = analyze("python3 -c \"open('out/a.txt', 'w').write('x')\"");
        expect(inline.kinds).toEqual(["write"]);
        expect(inline.hints).toEqual([`${REPO}/out/a.txt`]);
    });

    it("reads a shell script the session wrote as the command it runs", () => {
        const files = new Map([[`${TEMP}/continue.sh`, "#!/bin/zsh\ngit rebase --continue"]]);
        const analysis = analyze(`zsh ${TEMP}/continue.sh`, REPO, files);

        expect(analysis.kinds).toEqual(["git-rewrite"]);
    });

    it("keeps directories apart from files", () => {
        const analysis = analyze("mkdir -p out/dir && cp -r src dest && rm -rf gone && rm one.ts");

        expect(analysis.dirs).toEqual([`${REPO}/out/dir`, `${REPO}/dest`, `${REPO}/gone`]);
        expect(analysis.writes).toEqual([`${REPO}/one.ts`]);
    });
});

describe("pathExclusion", () => {
    it("names one reason per automatic kind, and none for a source file", () => {
        const ctx = { roots: [REPO], home: HOME, tempDirs: [TEMP] };
        const cases: [string, ExclusionReason | null][] = [
            [`${REPO}/src/a.ts`, null],
            [`${REPO}/src/logger/logs.ts`, null],
            [`${HOME}/Applications/App.app/Contents/MacOS/App`, "app-bundle"],
            [`${TEMP}/build.log`, "temp-dir"],
            [`${HOME}/.genesis-tools/logs/today.log`, "cache"],
            [`${REPO}/.cache/x.json`, "cache"],
            [`${REPO}/.git/info/exclude`, "git-metadata"],
            [`${REPO}/dist/index.js`, "build-output"],
            [`${REPO}/node_modules/zod/index.js`, "build-output"],
            [`${REPO}/.build/debug/App`, "build-output"],
            [`${REPO}/coverage/lcov.info`, "test-output"],
            [`${REPO}/src/__snapshots__/a.test.ts.snap`, "test-output"],
            [`${REPO}/logs/run.txt`, "log-file"],
            [`${REPO}/out.log`, "log-file"],
            [`${REPO}/bun.lock`, "lockfile-churn"],
            ["/elsewhere/a.ts", "outside-cwd"],
        ];

        for (const [path, reason] of cases) {
            expect({ path, reason: pathExclusion(path, ctx) }).toEqual({ path, reason });
        }

        expect(pathExclusion(`${REPO}/bun.lock`, { ...ctx, turnInstalls: true })).toBeNull();
        expect(pathExclusion(`${REPO}/src/__snapshots__/a.snap`, { ...ctx, snapshotsAllowed: true })).toBeNull();
    });

    it("tests directory names relative to the checkout, so a checkout under build/ is still source", () => {
        expect(
            pathExclusion("/work/build/app/src/a.ts", { roots: ["/work/build/app"], home: HOME, tempDirs: [TEMP] })
        ).toBeNull();
    });
});

describe("parseClaudeTranscript", () => {
    it("reads turns, file-tool before/after text, failures, harness detections and subagent calls", () => {
        const main = jsonl([
            prompt("p1", "change a", 0),
            use("t-edit", "Edit", { file_path: `${REPO}/a.ts`, old_string: "one", new_string: "$& two" }, 1),
            result("p1", "t-edit", 2, {
                toolUseResult: { originalFile: "one\n", oldString: "one", newString: "$& two" },
            }),
            use("t-new", "Write", { file_path: `${REPO}/new.ts`, content: "fresh\n" }, 3),
            result("p1", "t-new", 4, { toolUseResult: { type: "create", originalFile: null, content: "fresh\n" } }),
            use("t-bad", "Edit", { file_path: `${REPO}/b.ts`, old_string: "zz", new_string: "yy" }, 5),
            result("p1", "t-bad", 6, { isError: true }),
            use("t-sh", "Bash", { command: "bun scripts/codemod.ts" }, 7),
            result("p1", "t-sh", 8, {
                toolUseResult: {
                    bashEditDiff: {
                        files: [
                            { filePath: `${REPO}/c.ts`, hunks: [{ oldStart: 3, oldLines: 1 }] },
                            { filePath: `${REPO}/d.ts`, hunks: [{ oldStart: 0, oldLines: 0 }] },
                        ],
                    },
                },
            }),
            use("t-agent", "Agent", { prompt: "help" }, 9),
            result("p1", "t-agent", 30),
            prompt("p2", "and big.ts", 40),
            {
                type: "file-history-snapshot",
                messageId: "msg-p2",
                snapshot: {
                    messageId: "msg-p2",
                    trackedFileBackups: { "big.ts": { backupFileName: "big@v2", realParentDir: REPO } },
                },
            },
            use("t-big", "Edit", { file_path: `${REPO}/big.ts`, old_string: "old", new_string: "new" }, 41),
            result("p2", "t-big", 42, { toolUseResult: { originalFile: null, oldString: "old", newString: "new" } }),
        ]);
        const subagent = jsonl([
            { type: "user", promptId: "sub-prompt", timestamp: at(10), cwd: REPO, message: { content: "task" } },
            use("t-sub", "Write", { file_path: `${REPO}/by-agent.ts`, content: "agent\n" }, 11),
            result("sub-prompt", "t-sub", 12, { toolUseResult: { type: "create", originalFile: null } }),
        ]);
        const transcript = parseClaudeTranscript("fixture-session", {
            main,
            subagents: [{ agentId: "agent-1", content: subagent, parentToolUseId: "t-agent" }],
            readBackup: (name) => (name === "big@v2" ? "old body\n" : null),
        });
        const call = (id: string) => transcript.calls.find((item) => item.id === id);

        expect(transcript.turns.map((turn) => [turn.turnId, turn.index, turn.prompt])).toEqual([
            ["p1", 0, "change a"],
            ["p2", 1, "and big.ts"],
        ]);
        expect(call("t-edit")).toMatchObject({ turnId: "p1", before: "one\n", after: "$& two\n", isError: false });
        expect(call("t-new")).toMatchObject({ before: null, after: "fresh\n" });
        expect(call("t-bad")?.isError).toBe(true);
        expect(call("t-sh")?.harnessDetected).toEqual([
            { path: `${REPO}/c.ts`, created: false },
            { path: `${REPO}/d.ts`, created: true },
        ]);
        expect(call("t-sub")).toMatchObject({ agentId: "agent-1", turnId: "p1", before: null });
        expect(call("t-big")).toMatchObject({ turnId: "p2", before: "old body\n", after: "new body\n" });
        expect(applyReplacement("a b", "b", "$&$&", false)).toBe("a $&$&");
    });
});

describe("computeSessionChanges", () => {
    const transcript = parseClaudeTranscript("fixture-session", {
        main: jsonl([
            prompt("p1", "fix a", 0),
            use("edit-a", "Edit", { file_path: `${REPO}/src/a.ts`, old_string: "one", new_string: "two" }, 1),
            result("p1", "edit-a", 2, { toolUseResult: { originalFile: "one\n" } }),
            use("write-spec", "Write", { file_path: `${TEMP}/notes.md`, content: "notes\n" }, 3),
            result("p1", "write-spec", 4, { toolUseResult: { type: "create", originalFile: null } }),
            use("edit-bad", "Edit", { file_path: `${REPO}/src/c.ts`, old_string: "x", new_string: "y" }, 5),
            result("p1", "edit-bad", 6, { isError: true }),
            use("checkout", "Bash", { command: "git checkout -m other-branch" }, 10),
            result("p1", "checkout", 12),
            use("sed", "Bash", { command: "sed -i 's/a/b/' src/b.ts" }, 20),
            result("p1", "sed", 21),
            use("test", "Bash", { command: `bun run test > ${TEMP}/t.log 2>&1` }, 30),
            result("p1", "test", 40),
            prompt("p2", "look around", 100),
            use("rg", "Bash", { command: "rg -n foo src" }, 101),
            result("p2", "rg", 102),
            use("codemod", "Bash", { command: "bun scripts/codemod.ts" }, 110),
            result("p2", "codemod", 115),
            use("worktree-test", "Bash", { command: `cd ${OTHER} && bun run test` }, 120),
            result("p2", "worktree-test", 130),
            prompt("p3", "add a dependency", 200),
            use("add", "Bash", { command: "bun add zod" }, 201),
            result("p3", "add", 205),
        ]),
    });
    const log: LoggedChange[] = [
        row("p1", `${REPO}/src/x.ts`, 12),
        row("p1", `${REPO}/src/y.ts`, 12),
        row("p1", `${REPO}/src/b.ts`, 21, { beforeOid: "b0", afterOid: "b1" }),
        row("p1", `${TEMP}/t.log`, 40),
        row("p1", `${REPO}/coverage/lcov.info`, 40),
        row("p1", `${REPO}/src/z.ts`, 40),
        row("p2", `${REPO}/src/w.ts`, 102),
        row("p2", `${REPO}/src/v.ts`, 115, { beforeOid: "v0", afterOid: "v1" }),
        row("p2", `${REPO}/bun.lock`, 115),
        row("p2", `${REPO}/src/u.ts`, 130),
        row("p3", `${REPO}/package.json`, 205, { beforeOid: "p0", afterOid: "p1" }),
        row("p3", `${REPO}/bun.lock`, 205),
        row("p3", `${REPO}/node_modules/zod/index.js`, 205),
    ];
    const changes = compute({ transcript, log });
    const turn = (id: string) => changes.turns.find((item) => item.turnId === id);
    const reasons = (id: string) =>
        Object.fromEntries((turn(id)?.excluded ?? []).map((item) => [item.path, item.reason]));
    const kept = (id: string) => (turn(id)?.files ?? []).map((file) => [file.path, file.via, file.confidence]);

    it("keeps file-tool edits exactly, even outside the checkout, and drops a failed one", () => {
        expect(kept("p1")).toEqual([
            [`${TEMP}/notes.md`, "write", "exact"],
            [`${REPO}/src/a.ts`, "edit", "exact"],
            [`${REPO}/src/b.ts`, "bash", "high"],
        ]);
        expect(reasons("p1")[`${REPO}/src/c.ts`]).toBe("tool-failed");
    });

    it("excludes what a checkout rewrote and what a test run left, by the command that ran", () => {
        expect(reasons("p1")).toEqual({
            [`${REPO}/coverage/lcov.info`]: "test-output",
            [`${REPO}/src/c.ts`]: "tool-failed",
            [`${REPO}/src/x.ts`]: "git-rewrite",
            [`${REPO}/src/y.ts`]: "git-rewrite",
            [`${REPO}/src/z.ts`]: "test-output",
            [`${TEMP}/t.log`]: "temp-dir",
        });
    });

    it("keeps a script's changes, and drops what a read-only command or another checkout's command saw", () => {
        expect(kept("p2")).toEqual([[`${REPO}/src/v.ts`, "bash", "medium"]]);
        expect(reasons("p2")).toEqual({
            [`${REPO}/bun.lock`]: "lockfile-churn",
            [`${REPO}/src/u.ts`]: "not-written-by-command",
            [`${REPO}/src/w.ts`]: "not-written-by-command",
        });
    });

    it("keeps a lockfile and manifest in the turn that ran the install, never node_modules", () => {
        expect(kept("p3")).toEqual([
            [`${REPO}/bun.lock`, "bash", "medium"],
            [`${REPO}/package.json`, "bash", "medium"],
        ]);
        expect(reasons("p3")).toEqual({ [`${REPO}/node_modules/zod/index.js`]: "build-output" });
    });

    it("carries blob ids: a file tool's from its text, a shell change's from the log", () => {
        const byPath = new Map(changes.files.map((file) => [file.path, file]));

        expect(byPath.get(`${REPO}/src/a.ts`)?.beforeOid).toBe(gitBlobOid(Buffer.from("one\n")));
        expect(byPath.get(`${REPO}/src/a.ts`)?.afterOid).toBe(gitBlobOid(Buffer.from("two\n")));
        expect(byPath.get(`${TEMP}/notes.md`)?.beforeOid).toBeNull();
        expect(byPath.get(`${REPO}/src/b.ts`)).toMatchObject({ beforeOid: "b0", afterOid: "b1" });
        expect(gitBlobOid(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");

        const stored: Buffer[] = [];
        storeBlobs(changes.files, changes.blobs, (blobs) => {
            stored.push(...blobs);
            return blobs.map((bytes) => gitBlobOid(bytes));
        });
        expect(stored.map((bytes) => bytes.toString()).sort()).toEqual(["notes\n", "one\n", "two\n"]);
        expect(() => storeBlobs(changes.files, changes.blobs, (blobs) => blobs.map(() => "0000"))).toThrow();
    });

    it("selects the last turns that changed a file, and merges them first-before to last-after", () => {
        expect(lastChangedTurns(changes, 1).map((item) => item.turnId)).toEqual(["p3"]);
        expect(lastChangedTurns(changes, 2).map((item) => item.turnId)).toEqual(["p2", "p3"]);

        const merged = mergeTurnFiles(changes.turns.filter((item) => item.turnId !== "p1"));
        expect(merged.map((file) => file.path)).toEqual([
            `${REPO}/bun.lock`,
            `${REPO}/package.json`,
            `${REPO}/src/v.ts`,
        ]);
    });

    it("attributes a log row to the shell call that finished closest to it", () => {
        const twoCalls = parseClaudeTranscript("fixture-session", {
            main: jsonl([
                prompt("p1", "two commands", 0),
                use("first", "Bash", { command: "rg -n foo" }, 1),
                result("p1", "first", 2),
                use("second", "Bash", { command: "bun scripts/codemod.ts" }, 50),
                result("p1", "second", 60),
            ]),
        });
        const matched = compute({ transcript: twoCalls, log: [row("p1", `${REPO}/src/a.ts`, 60)] });

        expect(matched.turns[0]?.files[0]).toMatchObject({ path: `${REPO}/src/a.ts`, toolUseIds: ["second"] });

        // A row that names its call is attributed to it, whatever its timestamp says.
        const twoWriters = parseClaudeTranscript("fixture-session", {
            main: jsonl([
                prompt("p1", "two codemods", 0),
                use("first", "Bash", { command: "bun scripts/codemod-a.ts" }, 1),
                result("p1", "first", 2),
                use("second", "Bash", { command: "bun scripts/codemod-b.ts" }, 50),
                result("p1", "second", 60),
            ]),
        });
        const named = compute({
            transcript: twoWriters,
            log: [row("p1", `${REPO}/src/a.ts`, 60, { toolUseId: "first" })],
        });
        expect(named.turns[0]?.files[0]).toMatchObject({ path: `${REPO}/src/a.ts`, toolUseIds: ["first"] });
    });

    it("lists a named target nothing captured only when no change log covered the command", () => {
        const sedOnly = parseClaudeTranscript("fixture-session", {
            main: jsonl([
                prompt("p1", "edit by sed", 100),
                use("sed", "Bash", { command: "sed -i 's/a/b/' src/a.ts" }, 101),
                result("p1", "sed", 102),
            ]),
        });

        expect(compute({ transcript: sedOnly }).files.map((file) => [file.path, file.confidence])).toEqual([
            [`${REPO}/src/a.ts`, "low"],
        ]);
        // The log started before the call and recorded nothing for it: sed matched nothing.
        expect(compute({ transcript: sedOnly, log: [row("p0", `${REPO}/src/old.ts`, 0)] }).turns[0]?.files).toEqual([]);
    });

    it("judges the log alone by path rules when there is no transcript", () => {
        const logOnly = compute({
            transcript: null,
            log: [row("p1", `${REPO}/src/a.ts`, 1), row("p1", `${TEMP}/x.log`, 1)],
        });

        expect(logOnly.files.map((file) => [file.path, file.confidence])).toEqual([[`${REPO}/src/a.ts`, "low"]]);
        expect(logOnly.turns[0]?.excluded.map((item) => item.reason)).toEqual(["temp-dir"]);
    });

    it("never reports an unknown after-state as a deleted file", () => {
        const sedOnly = parseClaudeTranscript("fixture-session", {
            main: jsonl([
                prompt("p1", "edit by sed", 100),
                use("sed", "Bash", { command: "sed -i 's/a/b/' src/a.ts" }, 101),
                result("p1", "sed", 102),
            ]),
        });
        const [named] = compute({ transcript: sedOnly }).files;

        expect(named).toMatchObject({ path: `${REPO}/src/a.ts`, skipped: "no-before-state" });
        expect(named?.afterOid).toBeUndefined();

        // The first edit applies to the checkpoint, the second does not: the before-state is known, the after is not.
        const broken = parseClaudeTranscript("fixture-session", {
            main: jsonl([
                prompt("p1", "two edits", 0),
                snapshotLine("msg-p1", { "a.ts": { backupFileName: "a@v1", backupTime: at(0), realParentDir: REPO } }),
                use("e1", "Edit", { file_path: `${REPO}/a.ts`, old_string: "one", new_string: "two" }, 1),
                result("p1", "e1", 2, { toolUseResult: { originalFile: null } }),
                use("e2", "Edit", { file_path: `${REPO}/a.ts`, old_string: "absent", new_string: "x" }, 3),
                result("p1", "e2", 4, { toolUseResult: { originalFile: null } }),
            ]),
            readBackup: (name) => (name === "a@v1" ? "one\n" : null),
        });
        const [file] = compute({ transcript: broken }).files;

        expect(file).toMatchObject({ beforeOid: gitBlobOid(Buffer.from("one\n")), skipped: "no-after-state" });
        expect(file?.afterOid).toBeUndefined();
    });
});

function snapshotLine(messageId: string, trackedFileBackups: Record<string, unknown>): Line {
    return { type: "file-history-snapshot", messageId, snapshot: { messageId, trackedFileBackups } };
}

describe("checkpoint seeds", () => {
    it("does not seed a turn from a backup file a later entry of the same name overwrote", () => {
        // Claude reuses `name@v1` after a resume, so the file on disk holds the LATER state.
        const main = jsonl([
            prompt("p1", "first visit", 0),
            {
                type: "file-history-delta",
                snapshotMessageId: "msg-p1",
                trackingPath: `${REPO}/a.ts`,
                backup: { backupFileName: "a@v1", backupTime: at(1), realParentDir: REPO },
            },
            use("e1", "Edit", { file_path: `${REPO}/a.ts`, old_string: "one", new_string: "two" }, 2),
            result("p1", "e1", 3, { toolUseResult: { originalFile: null } }),
            prompt("p2", "after a resume", 100),
            {
                type: "file-history-delta",
                snapshotMessageId: "msg-p2",
                trackingPath: `${REPO}/a.ts`,
                backup: { backupFileName: "a@v1", backupTime: at(101), realParentDir: REPO },
            },
            use("e2", "Edit", { file_path: `${REPO}/a.ts`, old_string: "two", new_string: "three" }, 102),
            result("p2", "e2", 103, { toolUseResult: { originalFile: null } }),
        ]);
        const transcript = parseClaudeTranscript("fixture-session", { main, readBackup: () => "two\n" });
        const call = (id: string) => transcript.calls.find((item) => item.id === id);

        expect(call("e1")?.before).toBeUndefined();
        expect(call("e1")?.after).toBeUndefined();
        expect(call("e2")).toMatchObject({ before: "two\n", after: "three\n" });
    });

    it("leaves a call unknown when its edit does not apply to the seeded state", () => {
        const main = jsonl([
            prompt("p1", "edit", 0),
            snapshotLine("msg-p1", { "a.ts": { backupFileName: "a@v1", backupTime: at(0), realParentDir: REPO } }),
            use("e1", "Edit", { file_path: `${REPO}/a.ts`, old_string: "gone", new_string: "x" }, 1),
            result("p1", "e1", 2, { toolUseResult: { originalFile: null } }),
        ]);
        const transcript = parseClaudeTranscript("fixture-session", { main, readBackup: () => "other\n" });

        expect(transcript.calls[0]?.before).toBeUndefined();
        expect(compute({ transcript }).files[0]).toMatchObject({ skipped: "no-before-state" });
    });
});

describe("parseCodexRollout", () => {
    const line = (type: string, payload: Line, seconds: number): Line => ({ timestamp: at(seconds), type, payload });
    const fileChange = (turn: string, id: string, changes: Line, seconds: number, status = "completed"): Line =>
        line(
            "event_msg",
            { type: "item_completed", turn_id: turn, item: { type: "FileChange", id, status, changes } },
            seconds
        );

    const rollout = jsonl([
        line("event_msg", { type: "task_started", turn_id: "turn-1" }, 0),
        line("turn_context", { turn_id: "turn-1", cwd: REPO }, 0),
        line(
            "response_item",
            { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] },
            0
        ),
        line(
            "response_item",
            { type: "message", role: "user", content: [{ type: "input_text", text: "add a counter" }] },
            1
        ),
        fileChange(
            "turn-1",
            "exec-add",
            { [`${REPO}/src/new.ts`]: { type: "add", content: "export const n = 1;\n" } },
            2
        ),
        fileChange(
            "turn-1",
            "exec-up1",
            { [`${REPO}/src/a.ts`]: { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n one\n-two\n+2\n" } },
            3
        ),
        line("event_msg", { type: "task_started", turn_id: "turn-2" }, 10),
        fileChange(
            "turn-2",
            "exec-up2",
            { [`${REPO}/src/a.ts`]: { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n-one\n+1\n 2\n" } },
            11
        ),
        fileChange("turn-2", "exec-del", { [`${REPO}/src/old.ts`]: { type: "delete", content: "gone\n" } }, 12),
        fileChange("turn-2", "exec-declined", { [`${REPO}/src/b.ts`]: { type: "add", content: "x" } }, 13, "declined"),
    ]);
    const disk = new Map([
        [`${REPO}/src/a.ts`, "1\n2\n"],
        [`${REPO}/src/new.ts`, "export const n = 1;\n"],
    ]);
    const transcript = parseCodexRollout("thread-1", rollout, (path) => disk.get(path) ?? null);

    it("reads turns, prompts and one file call per completed change", () => {
        expect(transcript.turns.map((turn) => [turn.turnId, turn.prompt])).toEqual([
            ["turn-1", "add a counter"],
            ["turn-2", ""],
        ]);
        expect(transcript.calls.map((call) => [call.id, call.name, call.turnId])).toEqual([
            ["exec-add", "Write", "turn-1"],
            ["exec-up1", "Edit", "turn-1"],
            ["exec-up2", "Edit", "turn-2"],
            ["exec-del", "Edit", "turn-2"],
        ]);
    });

    it("walks update diffs back from the file on disk to each before-state", () => {
        const byId = new Map(transcript.calls.map((call) => [call.id, call]));

        expect([byId.get("exec-up2")?.before, byId.get("exec-up2")?.after]).toEqual(["one\n2\n", "1\n2\n"]);
        expect([byId.get("exec-up1")?.before, byId.get("exec-up1")?.after]).toEqual(["one\ntwo\n", "one\n2\n"]);
        expect([byId.get("exec-add")?.before, byId.get("exec-del")?.after]).toEqual([null, null]);
    });

    it("feeds the same per-turn model as a Claude transcript", () => {
        const changes = compute({ transcript });
        const turn2 = changes.turns.find((turn) => turn.turnId === "turn-2");

        expect(turn2?.files.map((file) => [file.path, file.toolUseIds])).toEqual([
            [`${REPO}/src/a.ts`, ["exec-up2"]],
            [`${REPO}/src/old.ts`, ["exec-del"]],
        ]);
        expect(changes.files.find((file) => file.path === `${REPO}/src/a.ts`)?.beforeOid).toBe(
            gitBlobOid(Buffer.from("one\ntwo\n"))
        );
    });

    it("leaves a before-state unknown when the file changed after the session", () => {
        const drifted = parseCodexRollout("thread-1", rollout, (path) =>
            path.endsWith("a.ts") ? "rewritten\n" : null
        );
        const up2 = drifted.calls.find((call) => call.id === "exec-up2");

        expect(up2?.after).toBe("rewritten\n");
        expect(up2?.before).toBeUndefined();
    });

    it("reads a move as the old path removed and the new path written with the text it carried", () => {
        const from = `${REPO}/src/old-name.ts`;
        const to = `${REPO}/src/new-name.ts`;
        const moves = jsonl([
            line("event_msg", { type: "task_started", turn_id: "turn-1" }, 0),
            fileChange(
                "turn-1",
                "exec-mv",
                { [from]: { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: to } },
                1
            ),
            // A later edit at the new path: the move's text is walked back through it, not read from disk.
            fileChange("turn-1", "exec-up", { [to]: { type: "update", unified_diff: "@@ -1 +1 @@\n-b\n+c\n" } }, 2),
        ]);
        const moved = parseCodexRollout("thread-2", moves, (path) => (path === to ? "c\n" : null));

        expect(moved.calls.map((call) => [call.id, call.name, call.filePath, call.before, call.after])).toEqual([
            ["exec-mv", "Edit", from, "a\n", null],
            ["exec-mv", "Write", to, null, "b\n"],
            ["exec-up", "Edit", to, "b\n", "c\n"],
        ]);
        expect(compute({ transcript: moved }).turns[0]?.files.map((file) => [file.path, file.toolUseIds])).toEqual([
            [to, ["exec-mv", "exec-up"]],
            [from, ["exec-mv"]],
        ]);
    });
});
