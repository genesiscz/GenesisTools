import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { auditCommits, buildCommits } from "./recommit";

const SCRIPT = join(import.meta.dir, "recommit.ts");

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function run(repo: TestRepo, args: string[]): RunResult {
    const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
        env: process.env,
        cwd: repo.dir,
        stdout: "pipe",
        stderr: "pipe",
    });
    return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

let repo: TestRepo;
let base: string;
let shas: string[];

/** Five commits over three areas; src/shared.ts is touched by an "api" commit and a "ui" commit. */
beforeEach(async () => {
    repo = await TestRepo.create();
    await repo.commitMany({ files: { "src/api/a.ts": "a\n", "src/old.ts": "old\n" }, message: "app" });
    base = await repo.sha();
    await repo.checkout("feat/work", { create: true });
    shas = [];
    await repo.commitMany({ files: { "src/api/a.ts": "a2\n", "src/shared.ts": "s1\n" }, message: "api one" });
    shas.push(await repo.sha());
    await repo.commit({ file: "src/ui/b.tsx", content: "b\n", message: "ui one" });
    shas.push(await repo.sha());
    await repo.commitMany({ files: { "src/shared.ts": "s2\n", "src/ui/b.tsx": "b2\n" }, message: "ui two" });
    shas.push(await repo.sha());
    await repo.git(["rm", "-q", "src/old.ts"]);
    await repo.git(["commit", "-q", "-m", "drop old"], { epoch: repo.tick() });
    shas.push(await repo.sha());
    await repo.commit({ file: "docs/readme.md", content: "doc\n", message: "docs" });
    shas.push(await repo.sha());
});

afterEach(() => {
    repo.cleanup();
});

function groupsFile(groups: unknown): string {
    const path = join(repo.root, "groups.json");
    writeFileSync(path, JSON.stringify(groups));
    return path;
}

const GOOD = () => [
    { message: "feat(api): api", commits: [shas[0]] },
    { message: "feat(ui): ui", commits: [shas[1], shas[2]] },
    { message: "chore: the rest", commits: [shas[3], shas[4]], paths: ["docs/**"], rest: true },
];

describe("recommit group", () => {
    test("places every path by commits, globs and rest, reports a shared path, and the plan checks", () => {
        const res = run(repo, ["group", "--base", base, "--groups", groupsFile(GOOD())]);

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("tree identity OK");
        // shared.ts: 1 touch by api, 1 by ui; the tie goes to the later group
        expect(res.stderr).toContain("shared src/shared.ts: 1/1/0 -> group 2");
        expect(res.stdout).toContain("1.    1 paths  feat(api): api");
        expect(res.stdout).toContain("2.    2 paths  feat(ui): ui");
        expect(res.stdout).toContain("3.    2 paths  chore: the rest");
    });

    test("refuses a commit in no group and a path two groups claim", () => {
        const groups = GOOD();
        groups[2] = { message: "chore: the rest", commits: [shas[3]], paths: ["docs/**", "src/ui/**"], rest: true };
        groups[1] = { ...groups[1], paths: ["src/ui/**"] } as (typeof groups)[number];
        const res = run(repo, ["group", "--base", base, "--groups", groupsFile(groups)]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain(`commit ${shas[4].slice(0, 9)} (docs) is in no group`);
        expect(res.stderr).toContain("path src/ui/b.tsx is claimed by groups 2, 3");
    });
});

describe("recommit apply", () => {
    test("moves the branch to N commits with head's exact tree, tags the old head, and leaves the checkout clean", async () => {
        const head = await repo.sha();
        const grouped = run(repo, ["group", "--base", base, "--groups", groupsFile(GOOD())]);
        expect(grouped.exitCode).toBe(0);

        const res = run(repo, ["apply", "--base", base, "--plan", join(repo.root, "groups.plan.txt")]);

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("feat/work:");
        expect((await repo.git(["rev-list", "--count", `${base}..feat/work`])).trim()).toBe("3");
        expect(await repo.git(["diff", head, "feat/work"])).toBe("");
        expect(await repo.git(["status", "--porcelain"])).toBe("");
        expect(await repo.git(["tag", "--list", "bkp/recommit/*"])).toContain("bkp/recommit/feat-work-");
        expect(await repo.git(["show", "--name-status", "--format=", "feat/work"])).toContain("D\tsrc/old.ts");
    });

    test("a plan missing a path moves nothing, and --dry-run moves nothing either", async () => {
        const head = await repo.sha();
        const plan = join(repo.root, "bad.plan.txt");
        writeFileSync(plan, "COMMIT 1: all\nFILES:\nsrc/api/a.ts\nsrc/shared.ts\nsrc/ui/b.tsx\ndocs/readme.md\n");

        const bad = run(repo, ["apply", "--base", base, "--plan", plan]);
        expect(bad.exitCode).toBe(1);
        expect(bad.stderr).toContain("missing: src/old.ts");

        run(repo, ["group", "--base", base, "--groups", groupsFile(GOOD())]);
        const dry = run(repo, ["apply", "--base", base, "--plan", join(repo.root, "groups.plan.txt"), "--dry-run"]);
        expect(dry.exitCode).toBe(0);
        expect(dry.stdout).toContain("dry run");
        expect(await repo.sha()).toBe(head);
    });
});

/**
 * The shapes that lose content when a recommit stages by hand: a mode-only change, a new symlink, a
 * deletion, a rename whose halves land in different groups, and a file added then removed again.
 */
describe("recommit edge cases", () => {
    test("apply keeps every edge byte for byte, and the per-path audit passes", async () => {
        const edge = await TestRepo.create();

        try {
            await edge.commitMany({
                files: { "bin/run.sh": "echo hi\n", "lib/old.ts": "old\n", "lib/gone.ts": "gone\n" },
                message: "base",
            });
            const edgeBase = await edge.sha();
            await edge.checkout("feat/edge", { create: true });
            await edge.git(["update-index", "--chmod=+x", "bin/run.sh"]);
            await edge.git(["commit", "-q", "-m", "make run.sh executable"], { epoch: edge.tick() });
            const chmod = await edge.sha();
            await edge.git(["mv", "lib/old.ts", "lib/new.ts"]);
            await edge.git(["commit", "-q", "-m", "rename old to new"], { epoch: edge.tick() });
            const rename = await edge.sha();
            await edge.git(["rm", "-q", "lib/gone.ts"]);
            await edge.git(["commit", "-q", "-m", "drop gone"], { epoch: edge.tick() });
            const drop = await edge.sha();
            symlinkSync("lib/new.ts", join(edge.dir, "link.ts"));
            await edge.git(["add", "link.ts"]);
            await edge.commit({ file: "tmp.txt", content: "temporary\n", message: "symlink and a temp file" });
            const link = await edge.sha();
            await edge.git(["rm", "-q", "tmp.txt"]);
            await edge.git(["commit", "-q", "-m", "remove the temp file"], { epoch: edge.tick() });
            const cleanup = await edge.sha();
            const groupsPath = join(edge.root, "groups.json");
            writeFileSync(
                groupsPath,
                JSON.stringify([
                    {
                        message: "chore: the executable bit and the old half of the move",
                        commits: [chmod, rename],
                        paths: ["lib/old.ts"],
                    },
                    {
                        message: "feat: the new half, the symlink and the cleanup",
                        commits: [drop, link, cleanup],
                        paths: ["lib/new.ts"],
                    },
                ])
            );

            const grouped = run(edge, ["group", "--base", edgeBase, "--groups", groupsPath]);
            expect(grouped.exitCode).toBe(0);
            expect(grouped.stdout).toContain("areas:");

            const applied = run(edge, ["apply", "--base", edgeBase, "--plan", join(edge.root, "groups.plan.txt")]);
            expect(applied.exitCode).toBe(0);
            expect(applied.stdout).toContain("per-path audit OK");
            expect(await edge.git(["diff", cleanup, "feat/edge"])).toBe("");
            expect(await edge.git(["ls-tree", "feat/edge", "bin/run.sh", "link.ts"])).toMatch(
                /^100755 blob \w+\tbin\/run\.sh\n120000 blob \w+\tlink\.ts\n?$/
            );
            expect(await edge.git(["ls-tree", "-r", "--name-only", "feat/edge"])).not.toContain("tmp.txt");
            // after commit 1 the old half of the move is gone and the new half has not arrived yet
            const afterFirst = await edge.git(["ls-tree", "-r", "--name-only", "feat/edge~1"]);
            expect(afterFirst).not.toContain("lib/old.ts");
            expect(afterFirst).not.toContain("lib/new.ts");
        } finally {
            edge.cleanup();
        }
    });

    test("--verify-each refuses to move the branch when a commit does not pass on its own", async () => {
        const head = await repo.sha();
        run(repo, ["group", "--base", base, "--groups", groupsFile(GOOD())]);

        const res = run(repo, [
            "apply",
            "--base",
            base,
            "--plan",
            join(repo.root, "groups.plan.txt"),
            "--verify-each",
            "test -f src/ui/b.tsx",
        ]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("--verify-each failed on 1 commit(s)");
        expect(res.stderr).toContain("commit 1");
        expect(await repo.sha()).toBe(head);
        expect(await repo.git(["worktree", "list"])).not.toContain("recommit-verify-");
    });
});

describe("auditCommits", () => {
    // negative control: the audit must fail on commits whose content does not follow the plan
    test("catches a path that changes in the wrong commit", async () => {
        run(repo, ["group", "--base", base, "--groups", groupsFile(GOOD())]);
        const head = await repo.sha();
        const planText = await Bun.file(join(repo.root, "groups.plan.txt")).text();
        const shas = buildCommits({ cwd: repo.dir, base, head, planText });

        expect(auditCommits({ cwd: repo.dir, base, head, planText, shas })).toEqual([]);

        const reordered = [shas[1], shas[0], shas[2]];
        const problems = auditCommits({ cwd: repo.dir, base, head, planText, shas: reordered });
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.join("\n")).toContain("belongs to another group");
    });
});
