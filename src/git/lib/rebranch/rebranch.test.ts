import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExecCallOptions, type ExecResult, Executor } from "@genesiscz/utils/cli/executor";
import { createGit } from "@genesiscz/utils/git";
import { hermeticGitEnv, TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import { readStateFile, writeStateFile } from "../state-file";
import {
    type ApplyRun,
    abortApply,
    applyCommands,
    applyStatePath,
    branchProblems,
    checkoutProblems,
    continueApply,
    loadApplyState,
    REBRANCH_LOCK_FILENAME,
    type RebranchState,
    runApply,
    withApplyLock,
} from "./apply";
import { type ApplyFlowIo, type ApplyOptions, runApplyFlow } from "./apply-flow";
import { analyseCommits, type HistoryCommit, type PathGroup, parseGroupSpec, pathMatches } from "./classify";
import { proveSplit, readSourceHistory } from "./history";
import { draftPlan, type PlanDocument, parsePlanText, type ResolvedGroup, resolvePlan } from "./plan";
import { type EntryMap, verifySplit } from "./verify";

/**
 * The git-driven cases spawn real `git` (each pick is two or three processes) and the last one a
 * cold `bun run` of the CLI; under the parallel suite that sits near the 5 s default, as it did
 * for cascade.test.ts.
 */
setDefaultTimeout(20_000);

const repos: TestRepo[] = [];

afterEach(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
});

const GROUPS: PathGroup[] = [
    { name: "api", patterns: ["api/**"] },
    { name: "web", patterns: ["web/**"] },
    { name: "docs", patterns: ["docs"] },
];

const lines = (prefix: string, changed: Record<number, string> = {}): string =>
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${changed[n] ?? `${prefix}${n}`}\n`).join("");

const config = (a: number): string => `{\n  "a": ${a}\n}\n`;

/**
 * master holds api/, web/, docs/ and shared/config.json; feat/messy then has nine commits: one IN
 * per group, a MIXED api+web commit (it also adds and deletes a web file, so paths-only on api
 * has to remove one and bring one back), a rename, a deletion, two commits on shared/config.json
 * that no group pattern covers (the second conflicts without the first), and one scratch commit.
 */
async function messy(r: TestRepo): Promise<void> {
    await r.commitMany({
        files: {
            "api/server.ts": lines("s"),
            "api/old-name.ts": "old\n",
            "web/app.ts": lines("w"),
            "web/legacy.ts": "legacy\n",
            "web/stale.ts": "stale\n",
            "docs/guide.md": "g1\n",
            "shared/config.json": config(1),
        },
        message: "base",
    });
    await r.checkout("feat/messy", { create: true });
    await r.commitMany({
        files: { "api/routes.ts": "routes\n", "api/server.ts": lines("s", { 1: "S1" }) },
        message: "feat(api): add routes",
    });
    await r.commit({ file: "web/app.ts", content: lines("w", { 1: "W1" }), message: "feat(web): new page" });
    await r.commit({ file: "docs/guide.md", content: "g1\ng2\n", message: "docs: guide update" });
    await r.git(["rm", "-q", "--", "web/stale.ts"]);
    await r.commitMany({
        files: {
            "api/server.ts": lines("s", { 1: "S1", 8: "S8" }),
            "web/app.ts": lines("w", { 1: "W1", 8: "W8" }),
            "web/widget.ts": "widget\n",
        },
        message: "feat: wire api and web",
    });
    await r.git(["mv", "api/old-name.ts", "api/handler.ts"]);
    await r.git(["commit", "-q", "-m", "refactor(api): rename old-name to handler"], { epoch: r.tick() });
    await r.commitDelete({ file: "web/legacy.ts", message: "chore(web): drop legacy" });
    await r.commit({ file: "shared/config.json", content: config(2), message: "chore(api): api config" });
    await r.commit({ file: "shared/config.json", content: config(3), message: "chore(web): web config" });
    await r.commit({ file: "notes.txt", content: "notes\n", message: "chore: scratch notes" });
}

async function messyRepo(): Promise<TestRepo> {
    const r = await TestRepo.fromScenario("rebranch:messy", messy, { prefix: "gt-rebranch-" });
    repos.push(r);
    return r;
}

type Edit = (doc: PlanDocument, sha: (subject: string) => string) => void;

/** Every MIXED decision paths-only; config commits 7+8 to api; the scratch commit skipped. */
const happy: Edit = (doc, sha) => {
    for (const g of doc.groups) {
        for (const c of g.commits) {
            c.decision ??= "paths-only";
        }
    }

    doc.groups[0].commits.push({ sha: sha("chore(api): api config") }, { sha: sha("chore(web): web config") });
    doc.skip = [sha("chore: scratch notes")];
};

/** Like `happy`, but the second config commit goes to web, where it conflicts without the first. */
const conflicting: Edit = (doc, sha) => {
    happy(doc, sha);
    doc.groups[0].commits.pop();
    doc.groups[1].commits.push({ sha: sha("chore(web): web config") });
};

/** `happy` cut down to the api group, which holds the paths-only commit: the cheapest plan that exercises a cleanup. */
const apiOnly: Edit = (doc, sha) => {
    happy(doc, sha);
    doc.groups.splice(1);
};

/** Like `happy`, but the scratch commit is left in no group and not skipped, so the final proof fails. */
const leavesACommitOut: Edit = (doc, sha) => {
    apiOnly(doc, sha);
    doc.skip = [];
};

/**
 * A path that exists on neither side: `web/x.ts` is added by a web commit, so the api branch never
 * gets it, and the next commit (api and web) deletes it and edits `web/y.ts`. On the api branch that
 * delete is a clean both-deleted merge, so the paths-only restore is handed a path it has no state for.
 * The commit also edits ` pad.txt`, whose name starts with a space: git lists it first, where the
 * executor's trim of the output would cut the space off.
 */
async function vanished(r: TestRepo): Promise<void> {
    await r.commitMany({
        files: { "api/server.ts": lines("s"), "web/y.ts": "y1\n", " pad.txt": "p1\n" },
        message: "base",
    });
    await r.checkout("feat/messy", { create: true });
    await r.commit({ file: "web/x.ts", content: "x\n", message: "feat(web): add x" });
    await r.git(["rm", "-q", "--", "web/x.ts"]);
    await r.commitMany({
        files: { "api/server.ts": lines("s", { 1: "S1" }), "web/y.ts": "y2\n", " pad.txt": "p2\n" },
        message: "feat: api change, drop x, edit y",
    });
}

/** Every MIXED decision paths-only, for the two groups of `vanished`. */
const vanishing: Edit = (doc) => {
    for (const g of doc.groups) {
        for (const c of g.commits) {
            c.decision ??= "paths-only";
        }
    }

    doc.groups.splice(2);
};

async function plannedSplit(r: TestRepo, edit: Edit) {
    const git = createGit({ cwd: r.dir });
    const history = await readSourceHistory(git, { source: "feat/messy", base: "master" });
    const doc = draftPlan({
        source: "feat/messy",
        sourceSha: history.sourceSha,
        base: "master",
        baseSha: history.baseSha,
        baseSource: "master (flag: --base)",
        mergeBase: history.mergeBase,
        groups: GROUPS,
        analysis: analyseCommits(history.commits, GROUPS),
    });
    const sha = (subject: string): string => {
        const hit = history.commits.find((c) => c.subject === subject);

        if (!hit) {
            throw new Error(`no commit "${subject}"`);
        }

        return hit.sha;
    };
    edit(doc, sha);
    const plan = parsePlanText(SafeJSON.stringify(doc), "test plan");
    const { resolved, problems } = resolvePlan(plan, history.commits);
    const state: RebranchState = {
        version: 1,
        startedAt: "2026-10-05T00:00:00.000Z",
        cwd: r.dir,
        plan: resolved,
        sourceSha: history.sourceSha,
        baseSha: history.baseSha,
        mergeBase: history.mergeBase,
        original: { branch: "feat/messy", sha: history.sourceSha },
        position: { group: 0, pick: 0 },
        pending: null,
        created: {},
        outcomes: [],
        phase: "running",
    };
    const run = { git, commonDir: join(r.dir, ".git"), state, report: () => {} };
    return { git, history, resolved, problems, run, sha, doc };
}

/**
 * A git that stops a run between two of its steps: the first command `at` matches either fails the way
 * git would (`fail`), or runs and then kills the process before anything else is saved (`kill-after`).
 */
class InterruptingExecutor extends Executor {
    private fired = false;

    constructor(
        cwd: string,
        private readonly at: (args: string[]) => boolean,
        private readonly how: "fail" | "kill-after"
    ) {
        super({ prefix: "git", cwd });
    }

    override async exec(args: string[], options?: ExecCallOptions): Promise<ExecResult> {
        if (this.fired || !this.at(args)) {
            return super.exec(args, options);
        }

        this.fired = true;

        if (this.how === "kill-after") {
            await super.exec(args, options);
            throw new Error("process killed");
        }

        return { success: false, stdout: "", stderr: "injected failure", exitCode: 1 };
    }
}

function interrupted(run: ApplyRun, at: (args: string[]) => boolean, how: "fail" | "kill-after"): ApplyRun {
    return { ...run, git: { ...run.git, executor: new InterruptingExecutor(run.state.cwd, at, how) } };
}

function requireState(commonDir: string): RebranchState {
    const saved = loadApplyState(commonDir);

    if (!saved) {
        throw new Error("the checkpoint was not saved");
    }

    return saved;
}

function recordingIo(confirm: ApplyFlowIo["confirm"] = null): { io: ApplyFlowIo; lines: string[] } {
    const lines: string[] = [];
    const record = (line: string): void => {
        lines.push(line);
    };

    return { io: { say: record, error: record, warn: record, info: record, success: record, confirm }, lines };
}

const applyFlow = (opts: ApplyOptions): Promise<number> => runApplyFlow(opts, recordingIo().io);

function commit(sha: string, paths: string[], subject = sha): HistoryCommit {
    return { sha, subject, paths };
}

const entry = (sha: string, mode = "100644") => ({ mode, sha });

function group(name: string, patterns: string[], picks: [string, "whole" | "skip" | "paths-only"][]): ResolvedGroup {
    return {
        name,
        branch: `split-${name}`,
        patterns,
        picks: picks.map(([sha, decision]) => ({ sha, subject: sha, decision, class: "IN", outsidePaths: [] })),
    };
}

describe("classify (pure)", () => {
    it("parses group specs and refuses a spec without name or paths", () => {
        expect(parseGroupSpec("api=src/api/**, ./docs/api")).toEqual({
            name: "api",
            patterns: ["src/api/**", "docs/api"],
        });
        expect(() => parseGroupSpec("src/api/**")).toThrow(/name=path/);
        expect(() => parseGroupSpec("api=")).toThrow(/no path patterns/);
        expect(() => parseGroupSpec("a b=x")).toThrow(/letters, digits/);
    });

    it("matches globs through the shared matcher and a bare pattern as a directory", () => {
        expect(pathMatches("api/v1/server.ts", "api/**")).toBe(true);
        expect(pathMatches("web/app.ts", "api/**")).toBe(false);
        expect(pathMatches("docs/guide.md", "docs")).toBe(true);
        expect(pathMatches("docs", "docs/")).toBe(true);
        expect(pathMatches("docsite/index.md", "docs")).toBe(false);
        expect(pathMatches("src/a.test.ts", "src/*.test.ts")).toBe(true);
    });

    it("classifies IN, OUTSIDE and MIXED and lists unassigned and shared commits", () => {
        const analysis = analyseCommits(
            [
                commit("a", ["api/x.ts"]),
                commit("b", ["api/x.ts", "web/y.ts"]),
                commit("c", ["notes.txt"]),
                commit("d", []),
            ],
            GROUPS
        );
        expect(analysis.commits.map((c) => [c.classes.api.class, c.classes.web.class])).toEqual([
            ["IN", "OUTSIDE"],
            ["MIXED", "MIXED"],
            ["OUTSIDE", "OUTSIDE"],
            ["OUTSIDE", "OUTSIDE"],
        ]);
        expect(analysis.commits[1].classes.api.outsidePaths).toEqual(["web/y.ts"]);
        expect(analysis.unassigned.map((c) => c.sha)).toEqual(["c", "d"]);
        expect(analysis.shared.map((c) => c.sha)).toEqual(["b"]);
        expect(() => analyseCommits([], [GROUPS[0], GROUPS[0]])).toThrow(/named twice/);
    });
});

describe("plan file (pure)", () => {
    const history = [
        commit("aaaa1111", ["api/x.ts"], "one"),
        commit("bbbbbbb2", ["api/x.ts", "web/y.ts"], "two"),
        commit("bbbbbbb3", ["notes.txt"], "three"),
    ];
    const plan = (groups: unknown[], skip: string[] = []) =>
        parsePlanText(SafeJSON.stringify({ version: 1, source: "feat/x", base: "master", groups, skip }), "p");

    it("validates the schema and names the bad field", () => {
        expect(() => parsePlanText("{ nope", "p.json")).toThrow(/p.json: not valid JSON/);
        expect(() =>
            plan([
                {
                    name: "api",
                    branch: "x",
                    paths: ["api/**"],
                    commits: [{ sha: "aaaa1111", decision: "maybe" }],
                },
            ])
        ).toThrow(/decision/);
        expect(() => parsePlanText(SafeJSON.stringify({ version: 1, source: "s", base: "b" }), "p")).toThrow(/groups/);
    });

    it("refuses an undecided MIXED commit, paths-only that keeps nothing, unknown and ambiguous shas", () => {
        const { problems, resolved } = resolvePlan(
            plan(
                [
                    {
                        name: "api",
                        branch: "feat/x-api",
                        paths: ["api/**"],
                        commits: [{ sha: "bbbbbbb2", decision: null }, { sha: "aaaa1111" }],
                    },
                    {
                        name: "web",
                        branch: "feat/x-web",
                        paths: ["web/**"],
                        commits: [{ sha: "bbbbbbb3", decision: "paths-only" }, { sha: "cccc4444" }, { sha: "bbbbbbb" }],
                    },
                ],
                ["bbbbbbb3"]
            ),
            history
        );
        expect(problems).toEqual([
            'group api: bbbbbbb2 "two" is MIXED (outside the group: web/y.ts); set decision to whole, skip or paths-only',
            'group web: bbbbbbb3 "three" changes no path of the group, so paths-only would keep nothing',
            "group web: cccc4444 is not a commit of feat/x since the merge-base",
            "group web: bbbbbbb is ambiguous (bbbbbbb2, bbbbbbb3)",
        ]);
        expect(resolved.unassigned).toEqual([]);
    });

    it("sorts picks into source order, defaults IN to whole and lists commits in no group", () => {
        const { problems, resolved } = resolvePlan(
            plan([
                {
                    name: "api",
                    branch: "feat/x-api",
                    paths: ["api/**"],
                    commits: [{ sha: "bbbbbbb2", decision: "paths-only" }, { sha: "aaaa1111" }],
                },
            ]),
            history
        );
        expect(problems).toEqual([]);
        expect(resolved.groups[0].picks.map((p) => [p.sha, p.decision, p.outsidePaths])).toEqual([
            ["aaaa1111", "whole", []],
            ["bbbbbbb2", "paths-only", ["web/y.ts"]],
        ]);
        expect(resolved.reordered).toEqual(["api"]);
        expect(resolved.unassigned.map((c) => c.sha)).toEqual(["bbbbbbb3"]);
        expect(applyCommands(resolved, { base: "master", returnTo: "feat/x" })).toEqual([
            "# api → feat/x-api (2 commits)",
            "git switch -c feat/x-api --no-track master",
            "git cherry-pick -x aaaa1111   # one",
            "git cherry-pick -x bbbbbbb2   # two",
            "#   paths-only: put back 1 path(s) outside api",
            "git restore --source=HEAD~1 --staged --worktree -- web/y.ts",
            "git commit --amend --no-edit --no-verify",
            "git switch feat/x",
        ]);
    });
});

describe("verifySplit (pure)", () => {
    const base: EntryMap = new Map([
        ["a.txt", entry("a0")],
        ["gone.txt", entry("g0")],
        ["s.txt", entry("s0")],
    ]);

    it("passes when every last change sits on its group, a deletion included", () => {
        const report = verifySplit({
            groups: [group("A", ["a.txt", "gone.txt"], [["c1", "whole"]]), group("S", ["s.txt"], [["c2", "whole"]])],
            history: [commit("c1", ["a.txt", "gone.txt"]), commit("c2", ["s.txt"])],
            skip: [],
            expected: new Map([
                ["a.txt", entry("a1")],
                ["s.txt", entry("s1")],
            ]),
            base,
            branches: {
                A: new Map([
                    ["a.txt", entry("a1")],
                    ["s.txt", entry("s0")],
                ]),
                S: new Map([
                    ["a.txt", entry("a0")],
                    ["gone.txt", entry("g0")],
                    ["s.txt", entry("s1")],
                ]),
            },
            unverifiable: [],
        });
        expect(report.ok).toBe(true);
        expect(report.paths.map((p) => [p.path, p.status, p.owners])).toEqual([
            ["a.txt", "ok", ["A"]],
            ["gone.txt", "ok", ["A"]],
            ["s.txt", "ok", ["S"]],
        ]);
    });

    it("fails on a changed blob, a lost mode bit, a resurrected file, a lost commit and an extra path", () => {
        const report = verifySplit({
            groups: [group("A", ["a.txt", "gone.txt", "x.sh"], [["c1", "whole"]])],
            history: [commit("c1", ["a.txt", "gone.txt", "x.sh"]), commit("c2", ["s.txt"], "loose")],
            skip: [],
            expected: new Map([
                ["a.txt", entry("a1")],
                ["s.txt", entry("s1")],
                ["x.sh", entry("x1", "100755")],
            ]),
            base,
            branches: {
                A: new Map([
                    ["a.txt", entry("tampered")],
                    ["gone.txt", entry("g0")],
                    ["s.txt", entry("s0")],
                    ["x.sh", entry("x1")],
                    ["new.txt", entry("n1")],
                ]),
            },
            unverifiable: [],
        });
        expect(report.ok).toBe(false);
        expect(report.paths.map((p) => [p.path, p.status])).toEqual([
            ["a.txt", "differs"],
            ["gone.txt", "differs"],
            ["s.txt", "lost"],
            ["x.sh", "differs"],
        ]);
        expect(report.paths[3].detail).toContain("the source has 100755 x1, A has 100644 x1");
        expect(report.extra).toEqual([{ group: "A", path: "new.txt" }]);
        expect(report.unassigned.map((c) => c.sha)).toEqual(["c2"]);
    });

    it("reports a dropped path for skip and paths-only, and a shared path that lost an earlier change", () => {
        const b = group(
            "B",
            ["b.txt"],
            [
                ["c2", "whole"],
                ["c3", "paths-only"],
            ]
        );
        b.picks[1].outsidePaths = ["a.txt"];
        const report = verifySplit({
            groups: [group("A", ["a.txt"], [["c1", "whole"]]), b],
            history: [
                commit("c1", ["s.txt"]),
                commit("c2", ["s.txt"]),
                commit("c3", ["b.txt", "a.txt"]),
                commit("c4", ["n"]),
            ],
            skip: ["c4"],
            expected: new Map([
                ["a.txt", entry("a3")],
                ["b.txt", entry("b3")],
                ["n", entry("n4")],
                ["s.txt", entry("s2")],
            ]),
            base,
            branches: {
                A: new Map([...base, ["s.txt", entry("s1")]]),
                B: new Map([...base, ["b.txt", entry("b3")], ["s.txt", entry("s2-without-c1")]]),
            },
            unverifiable: [],
        });
        expect(report.paths.map((p) => [p.path, p.status])).toEqual([
            ["a.txt", "dropped"],
            ["b.txt", "ok"],
            ["n", "dropped"],
            ["s.txt", "differs"],
        ]);
        expect(report.paths[0].detail).toContain("paths-only in B");
        expect(report.paths[2].detail).toContain("the plan skips that commit");
        expect(report.paths[3].detail).toContain("shared path: earlier commits picked into A also changed it");
        expect(report.extra).toEqual([]);
        expect(report.stripped).toEqual([{ group: "B", sha: "c3", paths: ["a.txt"] }]);
        expect(report.skipped).toEqual([{ group: null, sha: "c4", subject: "c4" }]);
        expect(report.ok).toBe(false);
    });

    it("treats a change the source undid as unchanged and a conflicting path as unverifiable", () => {
        const report = verifySplit({
            groups: [group("A", ["a.txt"], [["c1", "whole"]])],
            history: [commit("c1", ["a.txt"]), commit("c2", ["s.txt"]), commit("c3", ["s.txt"])],
            skip: [],
            expected: new Map([
                ["a.txt", entry("a1")],
                ["s.txt", entry("s0")],
            ]),
            base,
            branches: { A: new Map([...base, ["a.txt", entry("a1")]]) },
            unverifiable: ["a.txt"],
        });
        expect(report.paths.map((p) => [p.path, p.status])).toEqual([
            ["a.txt", "unverifiable"],
            ["s.txt", "ok"],
        ]);
        expect(report.ok).toBe(false);
    });
});

describe("state file", () => {
    it("replaces the file through a rename, so an interrupted write cannot truncate the checkpoint", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-state-file-"));
        const path = join(dir, "state.json");
        writeStateFile(path, { step: 1 });
        const inode = statSync(path).ino;

        writeStateFile(path, { step: 2 });
        expect(statSync(path).ino).not.toBe(inode);
        expect(readdirSync(dir)).toEqual(["state.json"]);
        expect(readStateFile<{ step: number }>(path)).toEqual({ step: 2 });
    });

    it("reads an unreadable file as no operation unless strict, and rebranch is strict", async () => {
        const r = await messyRepo();
        const commonDir = join(r.dir, ".git");
        const path = applyStatePath(commonDir);
        await Bun.write(path, '{"version": 1, "plan": ');

        expect(readStateFile(path)).toBeNull();
        expect(() => loadApplyState(commonDir)).toThrow("unreadable");
        await expect(applyFlow({ abort: true, cwd: r.dir })).rejects.toThrow("unreadable");
        await expect(applyFlow({ plan: join(r.root, "plan.json"), yes: true, cwd: r.dir })).rejects.toThrow(
            "unreadable"
        );
        expect(await Bun.file(path).text()).toBe('{"version": 1, "plan": ');
    });
});

describe("rebranch against a real repository", () => {
    it("reads the history with both halves of a rename and the deletion, and refuses merges", async () => {
        const r = await messyRepo();
        const git = createGit({ cwd: r.dir });
        const history = await readSourceHistory(git, { source: "feat/messy", base: "master" });
        const analysis = analyseCommits(history.commits, GROUPS);
        expect(history.merges).toEqual([]);
        expect(history.commits.find((c) => c.subject.startsWith("refactor(api)"))?.paths).toEqual([
            "api/handler.ts",
            "api/old-name.ts",
        ]);
        expect(history.commits.find((c) => c.subject === "chore(web): drop legacy")?.paths).toEqual(["web/legacy.ts"]);
        expect(analysis.commits.map((c) => GROUPS.map((g) => c.classes[g.name].class[0]).join(""))).toEqual([
            "IOO",
            "OIO",
            "OOI",
            "MMO",
            "IOO",
            "OIO",
            "OOO",
            "OOO",
            "OOO",
        ]);
        expect(analysis.unassigned).toHaveLength(3);

        await r.checkout("master");
        await r.git(["merge", "-q", "--no-ff", "-m", "merge messy", "feat/messy"], { epoch: r.tick() });
        await r.git(["branch", "-q", "feat/merged", "HEAD"]);
        await r.git(["reset", "-q", "--hard", "HEAD~1"]);
        const merged = await readSourceHistory(git, { source: "feat/merged", base: "master" });
        expect(merged.merges.map((m) => m.subject)).toEqual(["merge messy"]);
    });

    it("builds every group branch, returns to the start, proves the split, and catches a tampered branch", async () => {
        const r = await messyRepo();
        const { git, run, history, problems, resolved } = await plannedSplit(r, happy);
        expect(problems).toEqual([]);
        expect(await branchProblems(git, ["feat/messy", "feat/messy-api", "bad..name"])).toEqual([
            "branch feat/messy already exists; rebranch never overwrites a branch, pick another name",
            "bad..name is not a valid branch name",
        ]);

        const result = await runApply(run);
        expect(result.status).toBe("done");
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/messy");
        expect(await r.sha("feat/messy")).toBe(history.sourceSha);
        expect(await r.git(["log", "--reverse", "--format=%s", "master..feat/messy-api"])).toBe(
            [
                "feat(api): add routes",
                "feat: wire api and web",
                "refactor(api): rename old-name to handler",
                "chore(api): api config",
                "chore(web): web config",
            ].join("\n")
        );
        expect(await r.git(["log", "-1", "--format=%B", "feat/messy-docs"])).toContain("(cherry picked from commit");
        expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-web"])).toBe(
            "M\tweb/app.ts\nD\tweb/legacy.ts\nD\tweb/stale.ts\nA\tweb/widget.ts"
        );
        expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-api"])).toBe(
            "A\tapi/handler.ts\nD\tapi/old-name.ts\nA\tapi/routes.ts\nM\tapi/server.ts\nM\tshared/config.json"
        );
        expect(await r.git(["show", "feat/messy-web:web/app.ts"])).toBe(lines("w", { 1: "W1", 8: "W8" }).trimEnd());
        expect(loadApplyState(run.commonDir)?.phase).toBe("done");

        const proof = await proveSplit({ git, plan: resolved, history, baseSha: history.baseSha });
        expect(proof.report.ok).toBe(true);
        expect(proof.report.paths.filter((p) => p.status !== "ok").map((p) => [p.path, p.status])).toEqual([
            ["notes.txt", "dropped"],
        ]);

        await r.checkout("feat/messy-api");
        await r.commit({ file: "api/routes.ts", content: "tampered\n", message: "tamper" });
        await r.checkout("feat/messy");
        const tampered = await proveSplit({ git, plan: resolved, history, baseSha: history.baseSha });
        expect(tampered.report.ok).toBe(false);
        expect(tampered.report.paths.filter((p) => p.status === "differs").map((p) => p.path)).toEqual([
            "api/routes.ts",
        ]);
    });

    it("stops on a conflict, resumes with --continue after the fix, and --abort removes only what it made", async () => {
        const r = await messyRepo();
        const first = await plannedSplit(r, conflicting);
        const stopped = await runApply(first.run);
        expect(stopped).toMatchObject({ status: "conflict", group: "web", conflictFiles: ["shared/config.json"] });
        expect(await continueApply(first.run)).toMatchObject({ status: "conflict", group: "web" });
        expect(await abortApply(first.run, "20261005-000000")).toBe(true);
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/messy");
        expect(await r.git(["branch", "--list", "feat/messy-*"])).toBe("");
        expect(await r.git(["tag", "-l", "bkp/rebranch/*"])).toBe(
            "bkp/rebranch/feat-messy-api-20261005-000000\nbkp/rebranch/feat-messy-web-20261005-000000"
        );
        expect(loadApplyState(first.run.commonDir)).toBeNull();

        const second = await plannedSplit(r, conflicting);
        expect((await runApply(second.run)).status).toBe("conflict");
        r.write({ file: "shared/config.json", content: config(3) });
        await r.git(["add", "shared/config.json"]);
        await r.git(["cherry-pick", "--continue"], { epoch: r.tick() });
        const done = await continueApply(second.run);
        expect(done.status).toBe("done");
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/messy");

        const proof = await proveSplit({
            git: second.git,
            plan: second.resolved,
            history: second.history,
            baseSha: second.history.baseSha,
        });
        expect(proof.report.ok).toBe(true);
        expect(proof.report.paths.find((p) => p.path === "shared/config.json")).toMatchObject({
            status: "ok",
            owners: ["web"],
            sharedWith: ["api"],
        });
    });

    for (const step of [
        { name: "the restore fails", at: (args: string[]) => args.includes("restore"), how: "fail" as const },
        {
            name: "the amend fails after the restore",
            at: (args: string[]) => args.includes("--amend"),
            how: "fail" as const,
        },
        {
            name: "the process dies after the amend",
            at: (args: string[]) => args.includes("--amend"),
            how: "kill-after" as const,
        },
    ]) {
        it(`--continue finishes a landed paths-only pick without cherry-picking it again when ${step.name}`, async () => {
            const r = await messyRepo();
            const { run } = await plannedSplit(r, apiOnly);
            const stopped = runApply(interrupted(run, step.at, step.how));

            if (step.how === "kill-after") {
                await expect(stopped).rejects.toThrow("process killed");
            } else {
                expect(await stopped).toMatchObject({ status: "failed", group: "api" });
            }

            const saved = loadApplyState(run.commonDir);

            if (!saved) {
                throw new Error("the checkpoint was not saved");
            }

            expect((await continueApply({ ...run, state: saved })).status).toBe("done");
            expect(await r.git(["log", "--reverse", "--format=%s", "master..feat/messy-api"])).toBe(
                [
                    "feat(api): add routes",
                    "feat: wire api and web",
                    "refactor(api): rename old-name to handler",
                    "chore(api): api config",
                    "chore(web): web config",
                ].join("\n")
            );
            expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-api"])).toBe(
                "A\tapi/handler.ts\nD\tapi/old-name.ts\nA\tapi/routes.ts\nM\tapi/server.ts\nM\tshared/config.json"
            );
        });
    }

    it("--continue refuses to overwrite an edit to an outside path made while the restore was failing", async () => {
        const r = await messyRepo();
        const { run } = await plannedSplit(r, apiOnly);
        const stopped = await runApply(interrupted(run, (args) => args.includes("restore"), "fail"));
        expect(stopped).toMatchObject({ status: "failed", group: "api" });
        expect(loadApplyState(run.commonDir)?.pending?.stage).toBe("cleanup");

        r.write({ file: "web/app.ts", content: "mine\n" });
        const refused = await continueApply({ ...run, state: requireState(run.commonDir) });
        expect(refused).toMatchObject({ status: "failed", group: "api" });
        expect(refused.message).toContain("web/app.ts");
        expect(readFileSync(join(r.dir, "web/app.ts"), "utf8")).toBe("mine\n");
        expect(loadApplyState(run.commonDir)?.pending?.stage).toBe("cleanup");

        await r.git(["checkout", "--", "web/app.ts"]);
        expect((await continueApply({ ...run, state: requireState(run.commonDir) })).status).toBe("done");
        expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-api"])).toBe(
            "A\tapi/handler.ts\nD\tapi/old-name.ts\nA\tapi/routes.ts\nM\tapi/server.ts\nM\tshared/config.json"
        );
    });

    it("--continue refuses a staged change the cleanup did not make, and accepts the restore it did stage", async () => {
        const r = await messyRepo();
        const { run } = await plannedSplit(r, apiOnly);
        const stopped = await runApply(interrupted(run, (args) => args.includes("--amend"), "fail"));
        expect(stopped).toMatchObject({ status: "failed", group: "api" });
        const prePick = requireState(run.commonDir).pending?.prePick ?? "";
        const pickTip = await r.sha("feat/messy-api");

        r.write({ file: "api/extra.ts", content: "extra\n" });
        await r.git(["add", "api/extra.ts"]);
        const unrelated = await continueApply({ ...run, state: requireState(run.commonDir) });
        expect(unrelated).toMatchObject({ status: "failed", group: "api" });
        expect(unrelated.message).toContain("api/extra.ts");
        expect(await r.sha("feat/messy-api")).toBe(pickTip);
        await r.git(["rm", "-q", "-f", "--", "api/extra.ts"]);

        r.write({ file: "web/app.ts", content: "mine\n" });
        await r.git(["add", "web/app.ts"]);
        const edited = await continueApply({ ...run, state: requireState(run.commonDir) });
        expect(edited).toMatchObject({ status: "failed", group: "api" });
        expect(edited.message).toContain("web/app.ts");
        expect(await r.sha("feat/messy-api")).toBe(pickTip);
        await r.git(["restore", `--source=${prePick}`, "--staged", "--worktree", "--", "web/app.ts"]);

        expect((await continueApply({ ...run, state: requireState(run.commonDir) })).status).toBe("done");
        expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-api"])).toBe(
            "A\tapi/handler.ts\nD\tapi/old-name.ts\nA\tapi/routes.ts\nM\tapi/server.ts\nM\tshared/config.json"
        );
    });

    it("restores only the outside paths that differ, so a path that exists on neither side cannot fail the restore", async () => {
        const r = await TestRepo.fromScenario("rebranch:vanished", vanished, { prefix: "gt-rebranch-" });
        repos.push(r);
        const { run } = await plannedSplit(r, vanishing);

        expect(await runApply(run)).toMatchObject({ status: "done" });
        expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-api"])).toBe(
            "M\tapi/server.ts"
        );
        expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-web"])).toBe("M\tweb/y.ts");
    });

    it("runs one rebranch operation per repository: a second invocation from any worktree is refused while one holds the lock", async () => {
        const r = await messyRepo();
        const other = await r.worktreeAdd({ name: "other", ref: "feat/messy", detach: true });
        const commonDir = join(r.dir, ".git");
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify((await plannedSplit(r, conflicting)).doc, null, 2));
        const groupBranches = () => r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*"]);
        const busy = "another rebranch operation";

        await withApplyLock(commonDir, async () => {
            await expect(applyFlow({ plan: planPath, yes: true, cwd: other })).rejects.toThrow(busy);
        });
        expect(await groupBranches()).toBe("");
        expect(loadApplyState(commonDir)).toBeNull();

        expect(await applyFlow({ plan: planPath, yes: true, cwd: r.dir })).toBe(1);
        expect(existsSync(join(commonDir, REBRANCH_LOCK_FILENAME))).toBe(false);
        expect(loadApplyState(commonDir)?.phase).toBe("stopped");

        await withApplyLock(commonDir, async () => {
            await expect(applyFlow({ continue: true, cwd: other })).rejects.toThrow(busy);
            await expect(applyFlow({ abort: true, cwd: other })).rejects.toThrow(busy);
        });
        expect(await groupBranches()).toBe("feat/messy-api\nfeat/messy-web");
        expect(loadApplyState(commonDir)?.phase).toBe("stopped");

        expect(await applyFlow({ abort: true, cwd: other })).toBe(0);
        expect(await groupBranches()).toBe("");
        expect(loadApplyState(commonDir)).toBeNull();
        expect(existsSync(join(commonDir, REBRANCH_LOCK_FILENAME))).toBe(false);
    });

    it("refuses --dry-run with --continue or --abort, and --continue with --abort, before it touches anything", async () => {
        const r = await messyRepo();
        const commonDir = join(r.dir, ".git");
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify((await plannedSplit(r, conflicting)).doc, null, 2));
        const groupBranches = () => r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*"]);
        expect(await applyFlow({ plan: planPath, yes: true, cwd: r.dir })).toBe(1);
        const stateBefore = await Bun.file(applyStatePath(commonDir)).text();
        const head = await r.sha("HEAD");

        const refused = recordingIo();
        expect(await runApplyFlow({ abort: true, dryRun: true, cwd: r.dir }, refused.io)).toBe(2);
        expect(refused.lines).toEqual(["--dry-run previews a new apply, and --abort always acts; drop --dry-run"]);
        expect(await applyFlow({ continue: true, dryRun: true, cwd: r.dir })).toBe(2);
        expect(await applyFlow({ continue: true, abort: true, cwd: r.dir })).toBe(2);

        expect(await groupBranches()).toBe("feat/messy-api\nfeat/messy-web");
        expect(await r.git(["tag", "-l", "bkp/rebranch/*"])).toBe("");
        expect(await createGit({ cwd: r.dir }).isCherryPickInProgress()).toBe(true);
        expect(await r.sha("HEAD")).toBe(head);
        expect(await Bun.file(applyStatePath(commonDir)).text()).toBe(stateBefore);

        r.write({ file: "shared/config.json", content: config(3) });
        await r.git(["add", "shared/config.json"]);
        await r.git(["cherry-pick", "--continue"], { epoch: r.tick() });
        expect(await applyFlow({ continue: true, dryRun: true, cwd: r.dir })).toBe(2);
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/messy-web");
        expect(loadApplyState(commonDir)?.phase).toBe("stopped");

        expect(await applyFlow({ continue: true, cwd: r.dir })).toBe(0);
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/messy");
    });

    it("creates nothing until it was asked and the answer is yes, and needs --yes when nobody can be asked", async () => {
        const r = await messyRepo();
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify((await plannedSplit(r, happy)).doc, null, 2));
        const groupBranches = () => r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*"]);

        const unattended = recordingIo();
        expect(await runApplyFlow({ plan: planPath, cwd: r.dir }, unattended.io)).toBe(2);
        expect(unattended.lines).toContain("Non-interactive: pass --yes to run the plan as printed.");

        const declined = recordingIo(async () => false);
        expect(await runApplyFlow({ plan: planPath, cwd: r.dir }, declined.io)).toBe(1);
        expect(declined.lines).toContain("Cancelled. Nothing created.");
        expect(await groupBranches()).toBe("");
        expect(loadApplyState(join(r.dir, ".git"))).toBeNull();

        const asked: string[] = [];
        const accepted = recordingIo(async (message) => {
            asked.push(message);

            return true;
        });
        expect(await runApplyFlow({ plan: planPath, cwd: r.dir }, accepted.io)).toBe(0);
        expect(asked).toEqual(["Create these branches? (nothing is pushed)"]);
        expect(await groupBranches()).toBe("feat/messy-api\nfeat/messy-docs\nfeat/messy-web");
    });

    it("sees a rebase and a cherry-pick in progress inside a linked worktree", async () => {
        const r = await messyRepo();
        const wt = await r.worktreeAdd({ name: "wt", ref: "master" });
        const git = createGit({ cwd: wt });
        await r.git(["switch", "-q", "-c", "side"], { cwd: wt });
        await r.commit({ file: "shared/config.json", content: config(9), message: "side config", cwd: wt });
        await r.git(["rebase", "feat/messy"], { cwd: wt, allowFail: true });
        expect(await git.isRebaseInProgress()).toBe(true);
        await r.git(["rebase", "--abort"], { cwd: wt });
        expect(await git.isRebaseInProgress()).toBe(false);

        await r.git(["cherry-pick", "feat/messy"], { cwd: wt, allowFail: true });
        expect(await git.isCherryPickInProgress()).toBe(false);
        await r.git(["cherry-pick", "feat/messy~1"], { cwd: wt, allowFail: true });
        expect(await checkoutProblems(git)).toEqual([
            "a cherry-pick is in progress; finish or abort it first",
            "the checkout has uncommitted or untracked changes; commit or stash them first",
        ]);
    });

    it("keeps the checkout path absolute, so --abort works from another directory after a relative -C", async () => {
        const r = await messyRepo();
        const { doc } = await plannedSplit(r, conflicting);
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify(doc, null, 2));
        const start = process.cwd();

        try {
            process.chdir(r.root);
            expect(await applyFlow({ plan: planPath, yes: true, cwd: "repo" })).toBe(1);
            expect(loadApplyState(join(r.dir, ".git"))?.cwd).toBe(r.dir);

            process.chdir(dirname(r.root));
            expect(await applyFlow({ abort: true, cwd: r.dir })).toBe(0);
        } finally {
            process.chdir(start);
        }

        expect(await r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*"])).toBe("");
    });

    it("applies from a subdirectory of the checkout", async () => {
        const r = await messyRepo();
        const { doc } = await plannedSplit(r, happy);
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify(doc, null, 2));

        expect(await applyFlow({ plan: planPath, yes: true, cwd: join(r.dir, "api") })).toBe(0);
        expect(await r.git(["diff", "--name-status", "--no-renames", "master", "feat/messy-api"])).toBe(
            "A\tapi/handler.ts\nD\tapi/old-name.ts\nA\tapi/routes.ts\nM\tapi/server.ts\nM\tshared/config.json"
        );
    });

    it("stops instead of reporting done when the starting branch is taken, and --continue finishes once it is free", async () => {
        const r = await messyRepo();
        const { run } = await plannedSplit(r, conflicting);
        expect((await runApply(run)).status).toBe("conflict");
        const holder = await r.worktreeAdd({ name: "holder", ref: "feat/messy" });
        r.write({ file: "shared/config.json", content: config(3) });
        await r.git(["add", "shared/config.json"]);
        await r.git(["cherry-pick", "--continue"], { epoch: r.tick() });

        const stuck = await continueApply(run);
        expect(stuck).toMatchObject({ status: "failed", group: null });
        expect(stuck.message).toContain("could not switch back to feat/messy");
        expect(loadApplyState(run.commonDir)?.phase).toBe("stopped");

        await r.git(["worktree", "remove", holder]);
        expect((await continueApply(run)).status).toBe("done");
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/messy");
    });

    it("stops instead of reporting done when a detached start cannot be restored", async () => {
        const r = await messyRepo();
        const { run } = await plannedSplit(r, apiOnly);
        run.state.original = { branch: null, sha: "0".repeat(40) };

        const stuck = await runApply(run);
        expect(stuck).toMatchObject({ status: "failed", group: null });
        expect(stuck.message).toContain("could not return to 000000000 (detached)");
        expect(loadApplyState(run.commonDir)?.phase).toBe("stopped");
    });

    it("--abort removes nothing while it cannot leave the group branch, and keeps in the state what it cannot delete", async () => {
        const r = await messyRepo();
        const { run } = await plannedSplit(r, conflicting);
        expect((await runApply(run)).status).toBe("conflict");
        const original = await r.worktreeAdd({ name: "original", ref: "feat/messy" });
        const holdsApi = await r.worktreeAdd({ name: "holds-api", ref: "feat/messy-api" });
        const groupBranches = () => r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*"]);

        expect(await abortApply(run, "20261005-000001")).toBe(false);
        expect(await groupBranches()).toBe("feat/messy-api\nfeat/messy-web");
        expect(await r.git(["tag", "-l", "bkp/rebranch/*"])).toBe("");
        expect(loadApplyState(run.commonDir)?.created).toHaveProperty("feat/messy-web");

        await r.git(["worktree", "remove", original]);
        expect(await abortApply(run, "20261005-000002")).toBe(false);
        expect(await groupBranches()).toBe("feat/messy-api");
        expect(Object.keys(loadApplyState(run.commonDir)?.created ?? {})).toEqual(["feat/messy-api"]);

        await r.git(["worktree", "remove", holdsApi]);
        expect(await abortApply(run, "20261005-000003")).toBe(true);
        expect(await groupBranches()).toBe("");
        expect(loadApplyState(run.commonDir)).toBeNull();
        expect(await r.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/messy");
    });

    it("--abort tags branches that differ only by / and -, and reuses a tag an earlier attempt made", async () => {
        const r = await messyRepo();
        const { run } = await plannedSplit(r, (doc, sha) => {
            conflicting(doc, sha);
            doc.groups[0].branch = "feat/split";
            doc.groups[1].branch = "feat-split";
        });
        const reported: string[] = [];
        const logged: ApplyRun = {
            ...run,
            report: (line) => {
                reported.push(line);
            },
        };
        expect((await runApply(logged)).status).toBe("conflict");
        const slashTip = await r.sha("feat/split");
        const dashTip = await r.sha("feat-split");
        await r.git(["tag", "bkp/rebranch/feat-split-20261005-000000", slashTip]);

        expect(await abortApply(logged, "20261005-000000")).toBe(true);
        expect(await r.git(["tag", "-l", "bkp/rebranch/*"])).toBe(
            "bkp/rebranch/feat-split-20261005-000000\nbkp/rebranch/feat-split-20261005-000000-2"
        );
        expect(await r.sha("bkp/rebranch/feat-split-20261005-000000")).toBe(slashTip);
        expect(await r.sha("bkp/rebranch/feat-split-20261005-000000-2")).toBe(dashTip);
        expect(reported).toContain(
            `removed feat-split (was ${dashTip.slice(0, 9)}); restore with: git branch feat-split bkp/rebranch/feat-split-20261005-000000-2`
        );
    });

    it("keeps the apply state when the final proof fails, so --continue proves again and --abort undoes the run", async () => {
        const r = await messyRepo();
        const commonDir = join(r.dir, ".git");
        const { doc } = await plannedSplit(r, leavesACommitOut);
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify(doc, null, 2));

        expect(await applyFlow({ plan: planPath, yes: true, cwd: r.dir })).toBe(1);
        expect(loadApplyState(commonDir)?.phase).toBe("done");
        expect(await applyFlow({ continue: true, cwd: r.dir })).toBe(1);
        expect(loadApplyState(commonDir)?.phase).toBe("done");

        expect(await applyFlow({ abort: true, cwd: r.dir })).toBe(0);
        expect(await r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*"])).toBe("");
        expect(await r.git(["tag", "-l", "bkp/rebranch/*"])).toContain("bkp/rebranch/feat-messy-api-");
        expect(loadApplyState(commonDir)).toBeNull();
    });

    it("lets another apply replace the record of one whose proof failed, and leaves its branches", async () => {
        const r = await messyRepo();
        const commonDir = join(r.dir, ".git");
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify((await plannedSplit(r, leavesACommitOut)).doc, null, 2));
        expect(await applyFlow({ plan: planPath, yes: true, cwd: r.dir })).toBe(1);

        const again = await plannedSplit(r, (doc, sha) => {
            leavesACommitOut(doc, sha);
            doc.groups[0].branch = "again-api";
        });
        await Bun.write(planPath, SafeJSON.stringify(again.doc, null, 2));

        expect(await applyFlow({ plan: planPath, yes: true, cwd: r.dir })).toBe(1);
        expect(loadApplyState(commonDir)?.plan.groups[0].branch).toBe("again-api");
        expect(await r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*", "again-*"])).toBe(
            "again-api\nfeat/messy-api"
        );
    });

    it("the apply command prints what the flow reports and exits with its code, asking nobody without a terminal", async () => {
        const r = await messyRepo();
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify((await plannedSplit(r, happy)).doc, null, 2));

        const proc = Bun.spawn(
            ["bun", join(import.meta.dir, "../../index.ts"), "rebranch", "apply", "--plan", planPath, "-C", r.dir],
            { cwd: r.dir, env: hermeticGitEnv(), stdout: "pipe", stderr: "pipe" }
        );
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        expect(code).toBe(2);
        expect(stripAnsi(stdout + stderr)).toContain("Non-interactive: pass --yes to run the plan as printed.");
        expect(await r.git(["branch", "--list", "--format=%(refname:short)", "feat/messy-*"])).toBe("");
    });

    it("verify exits 1 and names the path when a group branch was changed after the split", async () => {
        const r = await messyRepo();
        const { run, history } = await plannedSplit(r, happy);
        expect((await runApply(run)).status).toBe("done");
        await r.checkout("feat/messy-web");
        await r.commit({ file: "web/app.ts", content: "tampered\n", message: "tamper" });
        await r.checkout("feat/messy");

        const doc = draftPlan({
            source: "feat/messy",
            sourceSha: history.sourceSha,
            base: "master",
            baseSha: history.baseSha,
            baseSource: "flag",
            mergeBase: history.mergeBase,
            groups: GROUPS,
            analysis: analyseCommits(history.commits, GROUPS),
        });
        happy(doc, (subject) => history.commits.find((c) => c.subject === subject)?.sha ?? "");
        const planPath = join(r.root, "plan.json");
        await Bun.write(planPath, SafeJSON.stringify(doc, null, 2));

        const proc = Bun.spawn(
            ["bun", join(import.meta.dir, "../../index.ts"), "rebranch", "verify", "--plan", planPath, "-C", r.dir],
            { cwd: r.dir, env: hermeticGitEnv(), stdout: "pipe", stderr: "pipe" }
        );
        const [raw, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        const stdout = stripAnsi(raw);
        expect(code).toBe(1);
        expect(stdout).toContain("DIFFERS web/app.ts");
        expect(stdout).toContain("NOT verified");
    });
});
