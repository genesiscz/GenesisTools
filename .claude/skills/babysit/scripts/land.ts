#!/usr/bin/env bun
/**
 * The landing recipe (SKILL.md step 7b) as one command, for a PR whose landing Martin approved and whose gates the
 * lead checked: squash the top `#<N> followup` commits into one, prove the tree identical, check the subjects, then
 * with --merge run the personal-data probe, push with a lease, wait for GitHub to see the new head and merge with
 * `tools github merge --rebase`. Every git call is an argument array: a hand-typed `--force-with-lease=$B:c1a…`
 * in zsh read `:c` as a modifier and pushed without the lease (2026-10-14, #502).
 *
 *   bun land.ts --run <dir> --pr <N> [--wt <dir>] [--merge] [--no-push-hooks]
 *
 * Without --merge it only prepares and prints the squash in the worktree (detached, nothing pushed).
 */
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { appendEvent } from "./ledger";
import { flag, has, loadRun, worktreeFor } from "./run";
import { HOOKS_OFF, newExecutablesStall, prepGit } from "./versions";

const run = loadRun();
const pr = Number(flag("--pr"));

if (!Number.isInteger(pr) || pr <= 0) {
    console.error("usage: land.ts --run <dir> --pr <N> [--wt <dir>] [--merge] [--no-push-hooks]");
    process.exit(2);
}

const wt = flag("--wt") ?? worktreeFor(run, pr);
const git = prepGit(wt);
const main = prepGit(run.main);

function must(result: { code: number; out: string }, what: string): string {
    if (result.code !== 0) {
        console.error(`✖ ${what}: ${result.out.trim().slice(0, 400)}`);
        process.exit(1);
    }

    return result.out.trim();
}

function spawnIn(cwd: string, cmd: string[]): { code: number; out: string } {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
    return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

const view = must(
    spawnIn(run.main, ["gh", "pr", "view", String(pr), "--json", "headRefName,baseRefName,state", "--repo", run.repo]),
    "gh pr view"
);
const {
    headRefName: branch,
    baseRefName: base,
    state,
} = SafeJSON.parse(view, { strict: true }) as {
    headRefName: string;
    baseRefName: string;
    state: string;
};

if (state !== "OPEN") {
    console.error(`✖ #${pr} is ${state}`);
    process.exit(1);
}

must(git(["fetch", "-q", "origin", base, branch]), "fetch");
must(git(["checkout", "-q", "--detach", `origin/${branch}`]), "checkout");
const oldHead = must(git(["rev-parse", "HEAD"]), "rev-parse");
const tree = must(git(["rev-parse", "HEAD^{tree}"]), "tree");

// The review commits are the contiguous `#N followup` commits on top of the feature commits.
const marker = new RegExp(`#${pr} followup\\b`);
const commits = must(git(["log", "--format=%H%x09%s", `origin/${base}..HEAD`]), "log")
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
const review = commits
    .slice(
        0,
        Math.max(
            0,
            commits.findIndex((c) => !marker.test(c.subject))
        )
    )
    .reverse();
const reviewAll = review.length === 0 && commits.length > 0 && commits.every((c) => marker.test(c.subject));

if (reviewAll) {
    console.error(`✖ every commit of #${pr} is a followup: no feature commit to squash onto`);
    process.exit(1);
}

if (review.length >= 2) {
    const scopes = [...new Set(review.flatMap((c) => /^\w+\(([^)]+)\)/.exec(c.subject)?.[1].split(/,\s*/) ?? []))];
    const message = [
        `fix(${scopes.join(", ")}): #${pr} followup - address PR review (${review.length} commits)`,
        "",
        ...review.map((c) => `- ${c.sha.slice(0, 9)} ${c.subject}`),
        "",
    ].join("\n");

    must(git(["reset", "-q", "--soft", `${review[0].sha}~1`]), "reset --soft");
    must(git(["commit", "-q", "-m", message]), "commit");

    if (must(git(["rev-parse", "HEAD^{tree}"]), "tree") !== tree) {
        console.error("✖ the squash changed the tree; nothing pushed");
        process.exit(1);
    }

    console.log(`✔ squashed ${review.length} review commits into ${must(git(["rev-parse", "--short", "HEAD"]), "")}`);
} else {
    console.log(`= ${review.length} review commit(s): nothing to squash`);
}

must(spawnIn(wt, ["bun", "scripts/git/check-commits.ts", `origin/${base}..HEAD`]), "check-commits");

// Martin's rule (2026-10-14 06:48): at most 10 commits per PR when it lands. Regroup a longer history into thematic
// commits with the same final tree first; this script never invents groups.
const count = Number(must(git(["rev-list", "--count", `origin/${base}..HEAD`]), "count"));

if (count > 10) {
    console.error(
        `✖ #${pr} has ${count} commits after the review squash; the limit is 10. Regroup it first (same tree).`
    );
    process.exit(1);
}
const newHead = must(git(["rev-parse", "HEAD"]), "rev-parse");

if (!has("--merge")) {
    console.log(`dry: #${pr} would push ${newHead.slice(0, 9)} over ${oldHead.slice(0, 9)} and merge with --rebase`);
    process.exit(0);
}

if (newHead !== oldHead) {
    must(spawnIn(wt, ["bash", "scripts/ci/placeholder-check.sh"]), "placeholder-check");
    const stalled = has("--no-push-hooks") && (await newExecutablesStall());

    if (has("--no-push-hooks") && !stalled) {
        console.log("= --no-push-hooks ignored: new executables start normally, so the push hooks run");
    }

    const hooks = stalled ? HOOKS_OFF : [];
    const push = spawnIn(wt, [
        "git",
        ...hooks,
        "push",
        "-q",
        `--force-with-lease=refs/heads/${branch}:${oldHead}`,
        "origin",
        `${newHead}:refs/heads/${branch}`,
    ]);
    must(push, "push");
    console.log(`✔ pushed ${branch} ${oldHead.slice(0, 9)}..${newHead.slice(0, 9)}`);
}

// `tools github merge` compares against the local remote ref and against what GitHub reports.
must(main(["fetch", "-q", "origin", base, branch]), "fetch in the main checkout");
const deadline = Date.now() + 120_000;

while (true) {
    const head = spawnIn(run.main, ["gh", "pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid"]);

    if (head.out.trim() === newHead) {
        break;
    }

    if (Date.now() > deadline) {
        console.error(`✖ GitHub still reports ${head.out.trim().slice(0, 9)} for #${pr} after 120 s; not merging`);
        process.exit(1);
    }

    await Bun.sleep(5_000);
}

const merged = await execTool(["github", "merge", "--rebase", String(pr)], { cwd: run.main, timeout: 600_000 });
console.log(merged.stdout.trim().split("\n").slice(-8).join("\n"));

if (!merged.success) {
    console.error(`✖ merge failed: ${merged.stderr.trim().slice(-400)}`);
    process.exit(1);
}

const sha = /sha:\s+([0-9a-f]{40})/.exec(merged.stdout)?.[1];
appendEvent(run.dir, {
    kind: "note",
    pr,
    text: `Merged into ${base} ${sha?.slice(0, 9) ?? "(sha not printed)"} by land.ts (${review.length} review commits squashed, tree identical).`,
});
console.log(`✔ #${pr} merged into ${base} ${sha?.slice(0, 9) ?? ""}`);
