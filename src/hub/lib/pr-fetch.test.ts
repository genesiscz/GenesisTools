import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit, TestRepo } from "@genesiscz/utils/git/test-repo";
import { classifyFetchError, fetchPrHead, PrFetchError, prPrivateRefs, prSourceRef } from "./pr-fetch";

/**
 * A scratch "host": a bare origin whose master moved on twice after the local clone (the PR
 * branched off the first move; the host records the second as the PR's base), with a PR ref
 * (`refs/pull/7/head`), an MR ref (`refs/merge-requests/9/head`) and a PR from a fork
 * (`refs/pull/11/head`, whose branch exists only in the fork). The local clone has none of them.
 */
let repo: TestRepo;
let origin: string;
let localMaster: string;
let forkPoint: string;
let baseTip: string;
let prHead: string;
let mrHead: string;
let forkHead: string;

async function git(cwd: string, args: string[]): Promise<string> {
    const res = await runGit({ cwd, args, epoch: repo.tick() });

    if (res.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }

    return res.stdout;
}

async function commitIn(cwd: string, file: string, content: string): Promise<string> {
    writeFileSync(join(cwd, file), content);
    await git(cwd, ["add", file]);
    await git(cwd, ["commit", "-q", "-m", `change ${file}`]);
    return git(cwd, ["rev-parse", "HEAD"]);
}

beforeAll(async () => {
    repo = await TestRepo.create({ prefix: "gt-pr-fetch-" });
    origin = await repo.addOrigin();
    localMaster = await repo.sha();

    const contributor = join(repo.root, "contributor");
    await git(repo.root, ["clone", "-q", origin, contributor]);
    forkPoint = await commitIn(contributor, "base.txt", "base moved on\n");

    await git(contributor, ["checkout", "-q", "-b", "feature/widgets"]);
    prHead = await commitIn(contributor, "widgets.ts", "export const widgets = 1;\n");
    await git(contributor, ["push", "-q", "origin", `${prHead}:refs/pull/7/head`]);
    mrHead = await commitIn(contributor, "gadgets.ts", "export const gadgets = 2;\n");
    await git(contributor, ["push", "-q", "origin", `${mrHead}:refs/merge-requests/9/head`]);

    await git(contributor, ["checkout", "-q", "master"]);
    baseTip = await commitIn(contributor, "base.txt", "base moved again\n");
    await git(contributor, ["push", "-q", "origin", "master"]);

    // The fork's branch reaches the base project only as its PR ref, which is how hosts store it.
    const fork = join(repo.root, "fork.git");
    await git(repo.root, ["init", "-q", "--bare", fork]);
    await git(contributor, ["checkout", "-q", "-b", "fork-only", "master"]);
    forkHead = await commitIn(contributor, "fork.ts", "export const fork = 3;\n");
    await git(contributor, ["push", "-q", fork, "fork-only"]);
    await git(origin, ["fetch", "-q", fork, "refs/heads/fork-only:refs/pull/11/head"]);
});

afterAll(() => {
    repo?.cleanup();
});

describe("prSourceRef / prPrivateRefs", () => {
    test("GitHub pull refs and GitLab merge-request refs, one private namespace", () => {
        expect(prSourceRef("github", 7)).toBe("refs/pull/7/head");
        expect(prSourceRef("gitlab", 9)).toBe("refs/merge-requests/9/head");
        expect(prPrivateRefs(7)).toEqual({ head: "refs/genesis/pr/7/head", base: "refs/genesis/pr/7/base" });
    });
});

describe("fetchPrHead", () => {
    test("fetches a GitHub PR head and its target branch into private refs only", async () => {
        const before = await repo.git([
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ]);
        const result = await fetchPrHead({
            repo: repo.dir,
            number: 7,
            head: prHead,
            base: baseTip,
            baseBranch: "master",
            provider: "github",
        });

        expect(result).toMatchObject({
            provider: "github",
            remote: "origin",
            sourceRef: "refs/pull/7/head",
            headRef: "refs/genesis/pr/7/head",
            head: prHead,
            base: baseTip,
            baseRef: "refs/genesis/pr/7/base",
            mergeBase: forkPoint,
            fetched: true,
            warnings: [],
        });
        // Branches, remote-tracking refs, tags, HEAD, FETCH_HEAD and the working tree stay as they were.
        expect(
            await repo.git([
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ])
        ).toBe(before);
        expect(await repo.git(["rev-parse", "refs/remotes/origin/master"])).toBe(localMaster);
        expect(await repo.sha()).toBe(localMaster);
        expect(await repo.git(["status", "--porcelain"])).toBe("");
        expect(existsSync(join(repo.dir, ".git", "FETCH_HEAD"))).toBe(false);
        expect(await repo.git(["diff", "--name-only", `${result.mergeBase}..${result.head}`])).toBe("widgets.ts");
    });

    test("a second call for the same head needs no network", async () => {
        // A remote that cannot answer: any fetch through it fails, so a pass proves none ran.
        await repo.git(["remote", "add", "offline", join(repo.root, "missing.git")]);
        const cached = await fetchPrHead({
            repo: repo.dir,
            number: 7,
            head: prHead,
            base: baseTip,
            baseBranch: "master",
            provider: "github",
            remote: "offline",
        });
        expect(cached).toMatchObject({ head: prHead, base: baseTip, mergeBase: forkPoint, fetched: false });
        // The control: without a known head the same remote is asked, and fails.
        const control = await fetchPrHead({ repo: repo.dir, number: 7, provider: "github", remote: "offline" }).catch(
            (error: unknown) => error
        );
        expect(control).toBeInstanceOf(PrFetchError);
    });

    test("fetches a GitLab MR head by its merge-request ref", async () => {
        const result = await fetchPrHead({ repo: repo.dir, number: 9, baseBranch: "master", provider: "gitlab" });

        expect(result).toMatchObject({
            sourceRef: "refs/merge-requests/9/head",
            headRef: "refs/genesis/pr/9/head",
            head: mrHead,
            fetched: true,
        });
        expect(await repo.git(["rev-parse", "refs/genesis/pr/9/head"])).toBe(mrHead);
    });

    test("a PR from a fork comes through the base project's PR ref", async () => {
        const result = await fetchPrHead({ repo: repo.dir, number: 11, head: forkHead, provider: "github" });

        expect(result.head).toBe(forkHead);
        expect(result.fetched).toBe(true);
    });

    test("a moved PR: the fetched head wins and says so", async () => {
        const stale = "0123456789abcdef0123456789abcdef01234567";
        const result = await fetchPrHead({ repo: repo.dir, number: 7, head: stale, provider: "github" });

        expect(result.head).toBe(prHead);
        expect(result.warnings.some((w) => w.includes("the PR moved"))).toBe(true);
    });

    test("errors: missing ref, missing remote, unknown host", async () => {
        const codeOf = (input: Parameters<typeof fetchPrHead>[0]) =>
            fetchPrHead(input).then(
                () => "no error",
                (error: unknown) => (error instanceof PrFetchError ? error.code : String(error))
            );

        expect(await codeOf({ repo: repo.dir, number: 404, provider: "github" })).toBe("ref-missing");
        expect(await codeOf({ repo: repo.dir, number: 7, provider: "github", remote: "upstream" })).toBe("no-remote");
        // The scratch origin is a local path, which names no host.
        expect(await codeOf({ repo: repo.dir, number: 7 })).toBe("unsupported-host");
        expect(await codeOf({ repo: join(repo.root, "not-here"), number: 7 })).toBe("not-a-repo");
    });
});

describe("classifyFetchError", () => {
    const code = (stderr: string) => classifyFetchError({ stderr, remote: "origin", ref: "refs/pull/1/head" }).code;

    test("auth, network and the rest", () => {
        expect(code("fatal: couldn't find remote ref refs/pull/1/head")).toBe("ref-missing");
        expect(code("git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe(
            "auth"
        );
        expect(
            code("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://host/g/p.git/'")
        ).toBe("auth");
        expect(code("fatal: could not read Username for 'https://host': terminal prompts disabled")).toBe("auth");
        expect(code("fatal: unable to access 'https://host/g/p.git/': Could not resolve host: host")).toBe("network");
        expect(code("ssh: connect to host host port 22: Operation timed out")).toBe("network");
        expect(code("fatal: bad object 1234")).toBe("git");
    });
});
