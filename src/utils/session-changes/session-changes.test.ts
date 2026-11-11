import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { parseCodexRollout } from "@genesiscz/utils/agent-sessions/readers/codex-changes";
import { findCodexRollout, isCodexRolloutPath } from "@genesiscz/utils/agent-sessions/readers/codex-locate";
import { changeLogPath } from "@genesiscz/utils/agents/change-log";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    analyzeCommand,
    computeSessionChanges,
    type ExclusionReason,
    expandVariables,
    fableSpecPaths,
    gitBlobOid,
    type LoggedChange,
    lastChangedTurns,
    loadSessionChanges,
    mergeTurnFiles,
    pathExclusion,
    type SessionChangesInput,
    type SessionToolCall,
    type SessionTranscript,
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

function jsonl(lines: Line[]): string {
    return lines.map((line) => SafeJSON.stringify(line, { strict: true })).join("\n");
}

function row(turn: string, path: string, seconds: number, extra: Partial<LoggedChange> = {}): LoggedChange {
    return {
        ts: at(seconds),
        provider: "claude",
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

/** Epoch ms of `at(seconds)`, as a reader records a call's start and finish. */
const ms = (seconds: number): number => Date.parse(at(seconds));

/** A tool call of a provider-neutral transcript fixture, in the main thread, started and finished at these seconds. */
function call(
    id: string,
    turnId: string,
    name: string,
    [started, finished]: [number, number],
    extra: Partial<SessionToolCall> = {}
): SessionToolCall {
    return {
        id,
        turnId,
        name,
        startedAt: ms(started),
        finishedAt: ms(finished),
        cwd: REPO,
        agentId: null,
        isError: false,
        filePath: null,
        command: null,
        ...extra,
    };
}

function shell(id: string, turnId: string, command: string, seconds: [number, number]): SessionToolCall {
    return call(id, turnId, "Bash", seconds, { command });
}

/** A provider-neutral transcript: its turns as `[turnId, prompt, seconds]`, in order, and its calls. */
function transcriptOf(
    sessionId: string,
    turns: [string, string, number][],
    calls: SessionToolCall[]
): SessionTranscript {
    return {
        sessionId,
        turns: turns.map(([turnId, prompt, seconds], index) => ({ turnId, index, at: at(seconds), prompt })),
        calls,
        cwds: [REPO],
    };
}

describe("computeSessionChanges", () => {
    const transcript = transcriptOf(
        "fixture-session",
        [
            ["p1", "fix a", 0],
            ["p2", "look around", 100],
            ["p3", "add a dependency", 200],
        ],
        [
            call("edit-a", "p1", "Edit", [1, 2], { filePath: `${REPO}/src/a.ts`, before: "one\n", after: "two\n" }),
            call("write-spec", "p1", "Write", [3, 4], { filePath: `${TEMP}/notes.md`, before: null, after: "notes\n" }),
            call("edit-bad", "p1", "Edit", [5, 6], { filePath: `${REPO}/src/c.ts`, isError: true }),
            shell("checkout", "p1", "git checkout -m other-branch", [10, 12]),
            shell("sed", "p1", "sed -i 's/a/b/' src/b.ts", [20, 21]),
            shell("test", "p1", `bun run test > ${TEMP}/t.log 2>&1`, [30, 40]),
            shell("rg", "p2", "rg -n foo src", [101, 102]),
            shell("codemod", "p2", "bun scripts/codemod.ts", [110, 115]),
            shell("worktree-test", "p2", `cd ${OTHER} && bun run test`, [120, 130]),
            shell("add", "p3", "bun add zod", [201, 205]),
        ]
    );
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

    it.each([
        [0, 2],
        [999, 2],
        [1000, 2],
        [0, 1003],
    ])(
        "touch ordering preserves discovery order after %i earlier touches for %i simultaneous touches",
        (prefix, count) => {
            const padding = Array.from({ length: prefix }, (_, index) =>
                call(`padding-${index}`, "p1", "Write", [1, 1], {
                    filePath: `${REPO}/src/padding.ts`,
                    before: "old\n",
                    after: "new\n",
                })
            );
            const edits = Array.from({ length: count }, (_, index) =>
                call(`edit-${index}`, "p2", "Edit", [10, 10], {
                    filePath: `${REPO}/src/ordered.ts`,
                    before: `${index}\n`,
                    after: `${index + 1}\n`,
                })
            );
            const result = compute({
                transcript: transcriptOf(
                    "fixture-session",
                    [
                        ["p1", "earlier touches", 0],
                        ["p2", "simultaneous edits", 10],
                    ],
                    [...padding, ...edits]
                ),
            });

            expect(result.turns[1]?.files[0]).toMatchObject({
                path: `${REPO}/src/ordered.ts`,
                toolUseIds: edits.map((edit) => edit.id),
                beforeOid: gitBlobOid(Buffer.from("0\n")),
                afterOid: gitBlobOid(Buffer.from(`${count}\n`)),
            });
        }
    );

    it("touch ordering keeps timestamps ahead of discovery order across a millisecond boundary", () => {
        const padding = Array.from({ length: 1000 }, (_, index) =>
            call(`padding-${index}`, "p1", "Write", [0, 0], {
                filePath: `${REPO}/src/padding.ts`,
                before: "old\n",
                after: "new\n",
                startedAt: null,
            })
        );
        const later = call("later", "p1", "Edit", [10.001, 10.001], {
            filePath: `${REPO}/src/ordered.ts`,
            before: "middle\n",
            after: "after\n",
        });
        const earlier = call("earlier", "p1", "Edit", [10, 10], {
            filePath: `${REPO}/src/ordered.ts`,
            before: "before\n",
            after: "middle\n",
        });
        const result = compute({
            transcript: transcriptOf("fixture-session", [["p1", "interleaved edits", 0]], [later, ...padding, earlier]),
        });

        expect(result.files.find((file) => file.path === `${REPO}/src/ordered.ts`)).toMatchObject({
            toolUseIds: ["earlier", "later"],
            beforeOid: gitBlobOid(Buffer.from("before\n")),
            afterOid: gitBlobOid(Buffer.from("after\n")),
        });
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
        const twoCalls = transcriptOf(
            "fixture-session",
            [["p1", "two commands", 0]],
            [shell("first", "p1", "rg -n foo", [1, 2]), shell("second", "p1", "bun scripts/codemod.ts", [50, 60])]
        );
        const matched = compute({ transcript: twoCalls, log: [row("p1", `${REPO}/src/a.ts`, 60)] });

        expect(matched.turns[0]?.files[0]).toMatchObject({ path: `${REPO}/src/a.ts`, toolUseIds: ["second"] });

        // A row that names its call is attributed to it, whatever its timestamp says.
        const twoWriters = transcriptOf(
            "fixture-session",
            [["p1", "two codemods", 0]],
            [
                shell("first", "p1", "bun scripts/codemod-a.ts", [1, 2]),
                shell("second", "p1", "bun scripts/codemod-b.ts", [50, 60]),
            ]
        );
        const named = compute({
            transcript: twoWriters,
            log: [row("p1", `${REPO}/src/a.ts`, 60, { toolUseId: "first" })],
        });
        expect(named.turns[0]?.files[0]).toMatchObject({ path: `${REPO}/src/a.ts`, toolUseIds: ["first"] });
    });

    it("lists a named target nothing captured only when no change log covered the command", () => {
        const sedOnly = transcriptOf(
            "fixture-session",
            [["p1", "edit by sed", 100]],
            [shell("sed", "p1", "sed -i 's/a/b/' src/a.ts", [101, 102])]
        );

        expect(compute({ transcript: sedOnly }).files.map((file) => [file.path, file.confidence])).toEqual([
            [`${REPO}/src/a.ts`, "low"],
        ]);
        // The log started before the call and recorded nothing for it: sed matched nothing.
        expect(compute({ transcript: sedOnly, log: [row("p0", `${REPO}/src/old.ts`, 0)] }).turns[0]?.files).toEqual([]);
    });

    it("computes only the turns of onlyTools, each exactly as the whole session does", () => {
        const scoped = compute({ transcript, log, onlyTools: ["codemod"] });
        const scopedTurn = (id: string) => scoped.turns.find((item) => item.turnId === id);

        expect(scopedTurn("p2")).toEqual(turn("p2"));
        expect(scopedTurn("p1")?.files).toEqual([]);
        expect(scopedTurn("p3")?.files).toEqual([]);
    });

    const writeScript = (id: string, body: string, seconds: [number, number]) =>
        shell(id, "p1", `cat > gen.sh <<'EOF'\n${body}\nEOF`, seconds);
    const runScript = shell("run", "p2", "zsh gen.sh", [11, 12]);

    it("still reads a heredoc script an earlier turn wrote when onlyTools runs it", () => {
        const scripted = transcriptOf(
            "fixture-session",
            [
                ["p1", "write a script", 0],
                ["p2", "run it", 10],
            ],
            [writeScript("heredoc", "echo hi > src/out.ts", [1, 2]), runScript]
        );
        const runLog = [row("p1", `${REPO}/gen.sh`, 2), row("p2", `${REPO}/src/out.ts`, 12)];
        const whole = compute({ transcript: scripted, log: runLog });
        const scoped = compute({ transcript: scripted, log: runLog, onlyTools: ["run"] });
        const p2 = (changes: typeof whole) => changes.turns.find((item) => item.turnId === "p2");

        expect(p2(scoped)).toEqual(p2(whole));
        expect(p2(scoped)?.files.map((file) => file.path)).toEqual([`${REPO}/src/out.ts`]);
    });

    it("keeps a call's analysis across asks of one session, and still replays the script it wrote", () => {
        // A resident process asks again as the session grows: the second ask sees the script's run appended.
        const first = transcriptOf(
            "kept-session",
            [["p1", "write a script", 0]],
            [writeScript("heredoc", "echo hi > src/out.ts", [1, 2])]
        );
        const grown = transcriptOf(
            "kept-session",
            [
                ["p1", "write a script", 0],
                ["p2", "run it", 10],
            ],
            [writeScript("heredoc", "echo hi > src/out.ts", [1, 2]), runScript]
        );
        const runLog = [row("p1", `${REPO}/gen.sh`, 2), row("p2", `${REPO}/src/out.ts`, 12)];
        const ask = (sessionId: string, transcript: typeof first) =>
            computeSessionChanges({
                sessionId,
                transcript,
                log: runLog,
                home: HOME,
                tempDirs: [TEMP],
                repoRoot,
                isDirectory: () => false,
            });
        ask("kept-session", first);
        const second = ask("kept-session", grown);
        const fresh = ask("kept-session-fresh", grown);
        const p2 = (changes: typeof second) => changes.turns.find((item) => item.turnId === "p2");

        expect(p2(second)).toEqual(p2(fresh));
        expect(p2(second)?.files.map((file) => file.path)).toEqual([`${REPO}/src/out.ts`]);
    });

    it("replays a cached script overwrite on a warm refresh", () => {
        const writes = [
            writeScript("first-write", "echo hi > src/old.ts", [1, 2]),
            writeScript("second-write", "echo hi > src/new.ts", [3, 4]),
        ];
        const first = transcriptOf("rewrite-session", [["p1", "write twice", 0]], writes);
        const grown = transcriptOf(
            "rewrite-session",
            [
                ["p1", "write twice", 0],
                ["p2", "run it", 10],
            ],
            [...writes, runScript]
        );
        const log = [row("p1", `${REPO}/gen.sh`, 4), row("p2", `${REPO}/src/new.ts`, 12)];
        const ask = (sessionId: string, transcript: typeof first) =>
            computeSessionChanges({
                sessionId,
                transcript,
                log,
                home: HOME,
                tempDirs: [TEMP],
                repoRoot,
                isDirectory: () => false,
            });
        ask("rewrite-session", first);
        const warm = ask("rewrite-session", grown);
        const cold = ask("rewrite-session-cold", grown);
        const turn = (changes: typeof warm) => changes.turns.find((item) => item.turnId === "p2");
        expect(turn(warm)).toEqual(turn(cold));
        expect(turn(warm)?.files.map((file) => file.path)).toEqual([`${REPO}/src/new.ts`]);
    });

    it("analyzes a kept call again when a script it runs changed on a later ask", () => {
        // The run call keeps its id, text and directory, but the script an earlier call wrote is another one now.
        const transcriptWith = (script: string) =>
            transcriptOf(
                "changed-script-session",
                [
                    ["p1", "write a script", 0],
                    ["p2", "run it", 10],
                ],
                [writeScript("write", script, [1, 2]), runScript]
            );
        const log = [row("p1", `${REPO}/gen.sh`, 2), row("p2", `${REPO}/src/new.ts`, 12)];
        const ask = (sessionId: string, script: string) =>
            computeSessionChanges({
                sessionId,
                transcript: transcriptWith(script),
                log,
                home: HOME,
                tempDirs: [TEMP],
                repoRoot,
                isDirectory: () => false,
            });
        ask("changed-script-session", "bun test");
        const warm = ask("changed-script-session", "echo hi > src/new.ts");
        const cold = ask("changed-script-session-cold", "echo hi > src/new.ts");
        const turn = (changes: typeof warm) => changes.turns.find((item) => item.turnId === "p2");

        expect(turn(warm)).toEqual(turn(cold));
        expect(turn(warm)?.files.map((file) => file.path)).toEqual([`${REPO}/src/new.ts`]);
    });

    it("judges the log alone by path rules when there is no transcript", () => {
        const logOnly = compute({
            transcript: null,
            log: [row("p1", `${REPO}/src/a.ts`, 1), row("p1", `${TEMP}/x.log`, 1)],
        });

        expect(logOnly.files.map((file) => [file.path, file.confidence])).toEqual([[`${REPO}/src/a.ts`, "low"]]);
        expect(logOnly.turns[0]?.excluded.map((item) => item.reason)).toEqual(["temp-dir"]);
    });

    it("loadSessionChanges reads the session's change log itself when the caller passes no rows", () => {
        const sessionId = `log-reader-${process.pid}`;
        const file = changeLogPath(sessionId);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${jsonl([{ ...row("p1", `${REPO}/src/made.ts`, 1), session: sessionId }])}\n`);

        const loaded = loadSessionChanges({ sessionId, home: HOME, tempDirs: [TEMP], repoRoot });
        const passed = loadSessionChanges({ sessionId, home: HOME, tempDirs: [TEMP], repoRoot, log: [] });

        expect(loaded.transcriptPath).toBeNull();
        expect(loaded.files.map((item) => [item.path, item.via])).toEqual([[`${REPO}/src/made.ts`, "bash"]]);
        expect(passed.files).toEqual([]);
    });

    it("never reports an unknown after-state as a deleted file", () => {
        const sedOnly = transcriptOf(
            "fixture-session",
            [["p1", "edit by sed", 100]],
            [shell("sed", "p1", "sed -i 's/a/b/' src/a.ts", [101, 102])]
        );
        const [named] = compute({ transcript: sedOnly }).files;

        expect(named).toMatchObject({ path: `${REPO}/src/a.ts`, skipped: "no-before-state" });
        expect(named?.afterOid).toBeUndefined();

        // The first edit's before- and after-state are known, the second's neither: the file's before is, its after is not.
        const broken = transcriptOf(
            "fixture-session",
            [["p1", "two edits", 0]],
            [
                call("e1", "p1", "Edit", [1, 2], { filePath: `${REPO}/a.ts`, before: "one\n", after: "two\n" }),
                call("e2", "p1", "Edit", [3, 4], { filePath: `${REPO}/a.ts` }),
            ]
        );
        const [file] = compute({ transcript: broken }).files;

        expect(file).toMatchObject({ beforeOid: gitBlobOid(Buffer.from("one\n")), skipped: "no-after-state" });
        expect(file?.afterOid).toBeUndefined();
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

    it("reaches loadSessionChanges only through each provider's reader, which finds the rollout by id", async () => {
        // A required member of every reader: a new provider answers here, and this module parses no transcript.
        for (const kind of ACCOUNT_PROVIDER_ALIASES) {
            expect([kind, typeof resolveHistoryProvider(kind).reader.readChanges]).toEqual([kind, "function"]);
        }

        expect(resolveHistoryProvider("grok").reader.readChanges("thread-reader")).toBeNull();

        const home = mkdtempSync(join(tmpdir(), "gt-codex-changes-"));
        const day = join(home, "sessions", "2026", "11", "02");
        const path = join(day, "rollout-2026-11-02T09-00-00-thread-reader.jsonl");
        mkdirSync(day, { recursive: true });
        writeFileSync(path, rollout);

        await env.testing.withOverrides({ CODEX_HOME: home }, () => {
            const loaded = loadSessionChanges({ sessionId: "thread-reader" });
            const read = resolveHistoryProvider("codex").reader.readChanges("thread-reader");

            expect(loaded.transcriptPath).toBe(path);
            expect(read?.transcript.calls.map((call) => call.id)).toEqual(
                parseCodexRollout("thread-reader", rollout).calls.map((call) => call.id)
            );
        });
    });
});

describe("findCodexRollout (Codex 0.164 compresses old rollouts to .jsonl.zst)", () => {
    it("finds a compressed rollout in the day tree and one directly in archived_sessions", () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-rollouts-"));
        const day = join(home, "sessions", "2026", "10", "01");
        mkdirSync(day, { recursive: true });
        mkdirSync(join(home, "archived_sessions"), { recursive: true });
        const compressed = join(day, "rollout-2026-10-01T09-00-00-thread-zst.jsonl.zst");
        const archived = join(home, "archived_sessions", "rollout-2026-03-10T20-11-50-thread-old.jsonl.zst");
        writeFileSync(compressed, "");
        writeFileSync(archived, "");

        expect(findCodexRollout("thread-zst", [home])).toBe(compressed);
        expect(findCodexRollout("thread-old", [home])).toBe(archived);
        expect(isCodexRolloutPath(compressed)).toBe(true);
    });

    it("logs a sessions folder it cannot read, and stays silent for one that is not there", () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-rollouts-"));
        // A file where the folder belongs: listing it fails with ENOTDIR, not ENOENT.
        writeFileSync(join(home, "sessions"), "");
        const debug = spyOn(logger, "debug");

        try {
            expect(findCodexRollout("thread-none", [home])).toBeNull();
            const dirs = debug.mock.calls
                .filter((call) => call[1] === "[transcripts] codex sessions directory not readable")
                .map((call) => {
                    const fields: unknown = call[0];
                    return typeof fields === "object" && fields !== null && "dir" in fields ? fields.dir : undefined;
                });
            expect(dirs).toEqual([join(home, "sessions")]);
        } finally {
            debug.mockRestore();
        }
    });
});
