import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermeticGitEnv, TEST_REPO_EPOCH, TestRepo } from "@genesiscz/utils/git/test-repo";
import { auditCommits, buildCommits } from "./recommit";
import { treeEntries } from "./recommit-plan-check";

const SCRIPT = join(import.meta.dir, "recommit.ts");

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * The CLI as a real process, awaited rather than through `Bun.spawnSync`: on the Linux CI runner
 * Bun 1.4.2's spawnSync can lose its child's exit inside a long-lived test worker
 * (oven-sh/bun#34069) and spin until the 20 s test timeout. On 2026-11-02 four of these seven
 * cases did that in one PR run, 80.5 s for a file a clean run finishes in under 3 s.
 */
async function run(repo: TestRepo, args: string[]): Promise<RunResult> {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
        env: process.env,
        cwd: repo.dir,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stdout, stderr };
}

/** git with stdin and extra env (a scratch GIT_INDEX_FILE), which `TestRepo.git` does not take. */
async function gitInput(
    cwd: string,
    args: string[],
    { input = "", env = {} }: { input?: string; env?: Record<string, string> } = {}
): Promise<string> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
        env: { ...hermeticGitEnv(TEST_REPO_EPOCH), ...env },
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
    }

    return stdout.trim();
}

let repo: TestRepo;
let base: string;
let shas: string[];

/** The base and the five feature shas, recorded by the one real build of the scenario below. */
let built: { base: string; shas: string[] } | null = null;

/**
 * Five commits over three areas; src/shared.ts is touched by an "api" commit and a "ui" commit.
 *
 * Built once per file and copied for every case (`TestRepo.fromScenario`): the commits are
 * deterministic, so every copy carries the shas the first build recorded. That build was fourteen
 * git processes per case, ~180 ms each time.
 */
beforeEach(async () => {
    repo = await TestRepo.fromScenario("recommit:five-commits", async (r) => {
        await r.commitMany({ files: { "src/api/a.ts": "a\n", "src/old.ts": "old\n" }, message: "app" });
        const first = await r.sha();
        await r.checkout("feat/work", { create: true });
        const recorded: string[] = [];
        await r.commitMany({ files: { "src/api/a.ts": "a2\n", "src/shared.ts": "s1\n" }, message: "api one" });
        recorded.push(await r.sha());
        await r.commit({ file: "src/ui/b.tsx", content: "b\n", message: "ui one" });
        recorded.push(await r.sha());
        await r.commitMany({ files: { "src/shared.ts": "s2\n", "src/ui/b.tsx": "b2\n" }, message: "ui two" });
        recorded.push(await r.sha());
        await r.git(["rm", "-q", "src/old.ts"]);
        await r.git(["commit", "-q", "-m", "drop old"], { epoch: r.tick() });
        recorded.push(await r.sha());
        await r.commit({ file: "docs/readme.md", content: "doc\n", message: "docs" });
        recorded.push(await r.sha());
        built = { base: first, shas: recorded };
    });

    // HEAD comes off the filesystem, so this check costs no process.
    if (built === null || (await repo.sha()) !== built.shas[4]) {
        throw new Error("the copied scenario does not end on the head its build recorded");
    }

    base = built.base;
    shas = [...built.shas];
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

let goodGroup: { result: RunResult; plan: string } | null = null;

/**
 * `group` with GOOD(), which five cases run on the same scenario. Each run is a cold `bun`
 * process (~210 ms), and the scenario and the groups are identical every time, so the first case
 * runs it for real and later cases get that run's result and its plan file written back where
 * `group` puts it.
 */
async function groupGood(): Promise<RunResult> {
    const groups = groupsFile(GOOD());
    const out = groups.replace(/\.json$/, ".plan.txt");

    if (goodGroup === null) {
        const result = await run(repo, ["group", "--base", base, "--groups", groups]);
        goodGroup = { result, plan: existsSync(out) ? readFileSync(out, "utf8") : "" };
        return result;
    }

    writeFileSync(out, goodGroup.plan);
    return goodGroup.result;
}

describe("recommit group", () => {
    test("places every path by commits, globs and rest, reports a shared path, and the plan checks", async () => {
        const res = await groupGood();

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("tree identity OK");
        // shared.ts: 1 touch by api, 1 by ui; the tie goes to the later group
        expect(res.stderr).toContain("shared src/shared.ts: 1/1/0 -> group 2");
        expect(res.stdout).toContain("1.    1 paths  feat(api): api");
        expect(res.stdout).toContain("2.    2 paths  feat(ui): ui");
        expect(res.stdout).toContain("3.    2 paths  chore: the rest");
    });

    test("refuses a commit in no group and a path two groups claim", async () => {
        const groups = GOOD();
        groups[2] = { message: "chore: the rest", commits: [shas[3]], paths: ["docs/**", "src/ui/**"], rest: true };
        groups[1] = { ...groups[1], paths: ["src/ui/**"] } as (typeof groups)[number];
        const res = await run(repo, ["group", "--base", base, "--groups", groupsFile(groups)]);

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain(`commit ${shas[4].slice(0, 9)} (docs) is in no group`);
        expect(res.stderr).toContain("path src/ui/b.tsx is claimed by groups 2, 3");
    });
});

describe("recommit apply", () => {
    test("moves the branch to N commits with head's exact tree, tags the old head, and leaves the checkout clean", async () => {
        const head = await repo.sha();
        const grouped = await groupGood();
        expect(grouped.exitCode).toBe(0);

        const res = await run(repo, ["apply", "--base", base, "--plan", join(repo.root, "groups.plan.txt")]);

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

        const bad = await run(repo, ["apply", "--base", base, "--plan", plan]);
        expect(bad.exitCode).toBe(1);
        expect(bad.stderr).toContain("missing: src/old.ts");

        await groupGood();
        const dry = await run(repo, [
            "apply",
            "--base",
            base,
            "--plan",
            join(repo.root, "groups.plan.txt"),
            "--dry-run",
        ]);
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

            const grouped = await run(edge, ["group", "--base", edgeBase, "--groups", groupsPath]);
            expect(grouped.exitCode).toBe(0);
            expect(grouped.stdout).toContain("areas:");

            const applied = await run(edge, [
                "apply",
                "--base",
                edgeBase,
                "--plan",
                join(edge.root, "groups.plan.txt"),
            ]);
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
        await groupGood();

        const res = await run(repo, [
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
        await groupGood();
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

describe("buildCommits", () => {
    test("refuses a path whose entry lookup comes back empty while head has it, before it writes any object", async () => {
        await groupGood();
        const head = await repo.sha();
        const planText = readFileSync(join(repo.root, "groups.plan.txt"), "utf8");
        const objectsBefore = await repo.git(["count-objects"]);
        const dropping: typeof treeEntries = (args) => {
            const entries = treeEntries(args);
            entries.delete("src/ui/b.tsx");
            return entries;
        };

        expect(() => buildCommits({ cwd: repo.dir, base, head, planText, readEntries: dropping })).toThrow(
            "src/ui/b.tsx"
        );
        expect(await repo.git(["count-objects"])).toBe(objectsBefore);
    });
});

/**
 * `git ls-tree -r` of this head is over 1 MiB, the default output limit of `spawnSync`. The bulk
 * is 6000 entries that share one blob, written with plumbing in a scratch index, so the fixture
 * costs a dozen git processes and no checkout.
 */
describe("recommit on a tree listing over 1 MiB", () => {
    test("group and apply --dry-run keep the paths that sort past the first MiB", async () => {
        const big = await TestRepo.create();

        try {
            const index = { GIT_INDEX_FILE: join(big.root, "big.index") };
            const blob = (input: string) => gitInput(big.dir, ["hash-object", "-w", "--stdin"], { input });
            const stage = (lines: string[]) =>
                gitInput(big.dir, ["update-index", "--index-info"], { env: index, input: `${lines.join("\n")}\n` });
            const commitIndex = async (parent: string, message: string) => {
                const tree = await gitInput(big.dir, ["write-tree"], { env: index });
                return gitInput(big.dir, ["commit-tree", tree, "-p", parent, "-m", message]);
            };
            const bulk = await blob("bulk\n");
            const dir = `bulk/${"a-long-directory-name-".repeat(8)}`;
            await gitInput(big.dir, ["read-tree", "HEAD"], { env: index });
            await stage([
                ...Array.from(
                    { length: 6000 },
                    (_, i) => `100644 ${bulk}\t${dir}/file-${String(i).padStart(5, "0")}.ts`
                ),
                `100644 ${await blob("start 1\n")}\taaa/start.ts`,
                `100644 ${await blob("end 1\n")}\tzzz/end.ts`,
                `100644 ${await blob("gone\n")}\tzzz/gone.ts`,
            ]);
            const bigBase = await commitIndex(await big.sha(), "bulk");
            await stage([`100644 ${await blob("start 2\n")}\taaa/start.ts`]);
            const startCommit = await commitIndex(bigBase, "start");
            await stage([`100644 ${await blob("end 2\n")}\tzzz/end.ts`, `0 ${"0".repeat(40)}\tzzz/gone.ts`]);
            const endCommit = await commitIndex(startCommit, "end and gone");
            await big.git(["update-ref", "refs/heads/feat/big", endCommit]);
            expect(Buffer.byteLength(await big.git(["ls-tree", "-r", "-z", "feat/big"]))).toBeGreaterThan(1024 * 1024);

            const groupsPath = join(big.root, "groups.json");
            writeFileSync(
                groupsPath,
                JSON.stringify([
                    { message: "feat: start", commits: [startCommit] },
                    { message: "feat: end", commits: [endCommit] },
                ])
            );
            const grouped = await run(big, ["group", "--base", bigBase, "--head", "feat/big", "--groups", groupsPath]);
            expect(grouped.stderr).not.toContain("✖");
            expect(grouped.exitCode).toBe(0);
            expect(grouped.stdout).toContain("tree identity OK");

            const applied = await run(big, [
                "apply",
                "--base",
                bigBase,
                "--head",
                "feat/big",
                "--plan",
                join(big.root, "groups.plan.txt"),
                "--dry-run",
            ]);
            expect(applied.stderr).not.toContain("✖");
            expect(applied.exitCode).toBe(0);
            const tip = /new tip ([0-9a-f]{40})/.exec(applied.stdout)?.[1] ?? "";
            expect(await big.tree(tip)).toBe(await big.tree("feat/big"));
            expect(await big.git(["show", "--name-status", "--format=", tip])).toBe("M\tzzz/end.ts\nD\tzzz/gone.ts");
        } finally {
            big.cleanup();
        }
    });
});

const ALICE = "Alice <alice@example.com>";
const BOB = "Bob <bob@example.com>";

/** The seed, then four commits on feat/authors: Alice, Bob, Alice, Bob, each adding one file. */
let authorsBuilt: { base: string; shas: string[] } | null = null;

async function twoAuthors(): Promise<{ repo: TestRepo; base: string; shas: string[] }> {
    const authored = await TestRepo.fromScenario("recommit:two-authors", async (r) => {
        const first = await r.sha();
        await r.checkout("feat/authors", { create: true });
        const recorded: string[] = [];

        for (const [author, file] of [
            [ALICE, "a/one.ts"],
            [BOB, "b/one.ts"],
            [ALICE, "a/two.ts"],
            [BOB, "b/two.ts"],
        ] as const) {
            r.write({ file, content: `${file}\n` });
            await r.git(["add", file]);
            await r.git(["commit", "-q", "--author", author, "-m", `add ${file}`], { epoch: r.tick() });
            recorded.push(await r.sha());
        }

        authorsBuilt = { base: first, shas: recorded };
    });

    if (authorsBuilt === null) {
        throw new Error("the two-authors scenario recorded no commits");
    }

    return { repo: authored, ...authorsBuilt };
}

/** One entry per commit of base..feat/authors, oldest first: `author|author date|subject|body`. */
async function authoredLog(r: TestRepo, from: string): Promise<string[]> {
    const out = await r.git(["log", "--reverse", "--format=%an|%aI|%s|%b%x1e", `${from}..feat/authors`]);
    return out
        .split("\x1e")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

describe("recommit body and author", () => {
    test("a group of one author's commits keeps that author and the last commit's date, with its body", async () => {
        const { repo: authored, base: from, shas: picks } = await twoAuthors();

        try {
            const groupsPath = join(authored.root, "groups.json");
            writeFileSync(
                groupsPath,
                JSON.stringify([
                    {
                        message: "feat(a): alice's files",
                        body: "Why Alice added them.\n\n- one\n- two",
                        commits: [picks[0], picks[2]],
                    },
                    { message: "feat(b): bob's files", commits: [picks[3], picks[1]] },
                ])
            );
            const grouped = await run(authored, ["group", "--base", from, "--groups", groupsPath]);
            expect(grouped.stderr).not.toContain("✖");
            expect(grouped.exitCode).toBe(0);
            expect(grouped.stderr).not.toContain("note:");

            const applied = await run(authored, [
                "apply",
                "--base",
                from,
                "--plan",
                join(authored.root, "groups.plan.txt"),
            ]);
            expect(applied.exitCode).toBe(0);
            const dateOf = async (sha: string) => (await authored.git(["log", "-1", "--format=%aI", sha])).trim();
            expect(await authoredLog(authored, from)).toEqual([
                `Alice|${await dateOf(picks[2])}|feat(a): alice's files|Why Alice added them.\n\n- one\n- two`,
                `Bob|${await dateOf(picks[3])}|feat(b): bob's files|`,
            ]);
            expect(await authored.git(["log", "-1", "--format=%cn", "feat/authors"])).toBe("Test");
        } finally {
            authored.cleanup();
        }
    });

    test("a mixed group keeps the current user with a note; author.from and an explicit author are copied", async () => {
        const { repo: authored, base: from, shas: picks } = await twoAuthors();

        try {
            const groupsPath = join(authored.root, "groups.json");
            writeFileSync(
                groupsPath,
                JSON.stringify([
                    { message: "feat: mixed", commits: [picks[0], picks[1]] },
                    { message: "feat: as bob", commits: [picks[2]], author: { from: picks[1] } },
                    {
                        message: "feat: as carol",
                        commits: [picks[3]],
                        author: { name: "Carol", email: "carol@example.com", date: "2024-01-02T03:04:05+01:00" },
                    },
                ])
            );
            const grouped = await run(authored, ["group", "--base", from, "--groups", groupsPath]);
            expect(grouped.exitCode).toBe(0);
            expect(grouped.stderr).toContain("note: group 1 (feat: mixed)");
            expect(grouped.stderr).toContain("current git user");

            const applied = await run(authored, [
                "apply",
                "--base",
                from,
                "--plan",
                join(authored.root, "groups.plan.txt"),
            ]);
            expect(applied.exitCode).toBe(0);
            const bobDate = (await authored.git(["log", "-1", "--format=%aI", picks[1]])).trim();
            const log = await authoredLog(authored, from);
            expect(log[0]).toStartWith("Test|");
            expect(log[0]).toEndWith("|feat: mixed|");
            expect(log.slice(1)).toEqual([
                `Bob|${bobDate}|feat: as bob|`,
                "Carol|2024-01-02T03:04:05+01:00|feat: as carol|",
            ]);
        } finally {
            authored.cleanup();
        }
    });

    test("an author date git cannot parse fails the plan check before anything is built", async () => {
        const { repo: authored, base: from, shas: picks } = await twoAuthors();

        try {
            const groupsPath = join(authored.root, "groups.json");
            writeFileSync(
                groupsPath,
                JSON.stringify([
                    {
                        message: "feat: all",
                        commits: picks,
                        author: { name: "Carol", email: "carol@example.com", date: "not a date" },
                    },
                ])
            );
            const grouped = await run(authored, ["group", "--base", from, "--groups", groupsPath]);
            expect(grouped.exitCode).toBe(1);
            expect(grouped.stderr).toContain("group 1: author Carol <carol@example.com> not a date");
            expect(grouped.stderr).toContain("invalid date format");
        } finally {
            authored.cleanup();
        }
    });

    test("a plan file without AUTHOR and BODY lines still applies, as the current user", async () => {
        const { repo: authored, base: from } = await twoAuthors();

        try {
            const plan = join(authored.root, "old.plan.txt");
            writeFileSync(
                plan,
                "COMMIT 1: feat: a\nFILES:\na/one.ts\na/two.ts\n\nCOMMIT 2: feat: b\nFILES:\nb/one.ts\nb/two.ts\n"
            );
            const applied = await run(authored, ["apply", "--base", from, "--plan", plan]);
            expect(applied.stderr).not.toContain("✖");
            expect(applied.exitCode).toBe(0);
            const log = await authoredLog(authored, from);
            expect(log.map((entry) => entry.replace(/\|[^|]*\|/, "|<date>|"))).toEqual([
                "Test|<date>|feat: a|",
                "Test|<date>|feat: b|",
            ]);
        } finally {
            authored.cleanup();
        }
    });
});
