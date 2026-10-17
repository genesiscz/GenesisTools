#!/usr/bin/env bun
/**
 * Fetch one PR round's review input into the worker's worktree, for a worker whose sandbox has no network.
 * A Codex worker's `tools github review` and `gh` fail there (getaddrinfo ENOTFOUND api.github.com): on
 * 2026-10-16 two round 2 fixers stopped before their first edit. The lead runs this before the spawn or steer;
 * the brief then points at the files.
 *
 *   bun fetch-threads.ts --run <dir> --pr 533 --round 2 [--wt <dir>]
 *
 * Writes, under `<worktree>/.claude/work/babysit/`:
 *   <pr>-r<round>-threads.md       every unresolved thread (any reviewer), listed and then expanded, with Thread IDs
 *   <pr>-r<round>-review-bodies.md every review body (CodeRabbit keeps "Outside diff range" and other findings there)
 *   <pr>-r<round>-pr-comments.md   PR comments with authors, except our round summaries and named bot notices
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { flag, loadRun, worktreeFor } from "./run";

/** The `t<n>` refs a `tools github review --llm` listing names, each once, in numeric order. */
export function threadRefs(listing: string): string[] {
    const refs = new Set(listing.match(/\bt\d+\b/g) ?? []);
    return [...refs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

async function reviewRead(args: string[], cwd: string): Promise<string> {
    const result = await execTool(args, { cwd, timeout: 120_000 });
    if (!result.success) {
        throw new Error("review read exited " + result.exitCode + ": " + result.stderr.toString().slice(0, 300));
    }
    return result.stdout.toString();
}

function capture(cmd: string[], cwd: string): string {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000 });

    if (p.exitCode !== 0) {
        throw new Error(`${cmd.slice(0, 4).join(" ")} exited ${p.exitCode}: ${p.stderr.toString().slice(0, 300)}`);
    }

    return p.stdout.toString();
}

interface Review {
    user: { login: string };
    commit_id: string;
    state: string;
    body: string;
}

interface IssueComment {
    user: { login: string };
    created_at: string;
    body: string;
}

if (import.meta.main) {
    const run = loadRun();
    const pr = flag("--pr") ?? "";
    const round = flag("--round") ?? "1";
    const wt = flag("--wt") ?? worktreeFor(run, pr);
    const dir = join(wt, ".claude/work/babysit");
    const session = `lead-${pr}-r${round}`;
    mkdirSync(dir, { recursive: true });

    const listing = await reviewRead(
        ["github", "review", pr, "--repo", run.repo, "--llm", "-u", "-s", session],
        run.main
    );
    const refs = threadRefs(listing);
    const expanded =
        refs.length > 0
            ? await reviewRead(["github", "review", "expand", refs.join(","), "-s", session], run.main)
            : "";
    writeFileSync(join(dir, `${pr}-r${round}-threads.md`), `${listing}\n## Expanded\n\n${expanded}`);

    const reviews = SafeJSON.parse(
        capture(["gh", "api", `repos/${run.repo}/pulls/${pr}/reviews?per_page=100`, "--paginate", "--slurp"], run.main),
        { strict: true }
    ).flat() as Review[];
    const bodies = reviews
        .filter((review) => review.body.trim() !== "")
        .map((r) => `### review by ${r.user.login} on ${r.commit_id.slice(0, 9)} (${r.state})\n${r.body}\n`);
    writeFileSync(join(dir, `${pr}-r${round}-review-bodies.md`), bodies.join("\n"));

    const comments = SafeJSON.parse(
        capture(
            ["gh", "api", `repos/${run.repo}/issues/${pr}/comments?per_page=100`, "--paginate", "--slurp"],
            run.main
        ),
        { strict: true }
    ).flat() as IssueComment[];
    const me = capture(["gh", "api", "user", "--jq", ".login"], run.main).trim();
    const commentBodies = comments
        .filter((comment) => {
            const { body, user } = comment;
            if (user.login === me && /^# Review fixes(?:\s|$)/.test(body.trimStart())) {
                return false;
            }
            const codeRabbit = ["coderabbitai", "coderabbitai[bot]"].includes(user.login);
            const rateNotice = body.includes(
                "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->"
            );
            const replyNotice =
                body.includes("<!-- This is an auto-generated reply by CodeRabbit -->") &&
                (body.includes("Review rate limited.") || body.includes("<summary>✅ Action performed</summary>"));
            return !(codeRabbit && (rateNotice || replyNotice));
        })
        .map((c) => `### comment by ${c.user.login} at ${c.created_at}\n${c.body}\n`);
    writeFileSync(join(dir, `${pr}-r${round}-pr-comments.md`), commentBodies.join("\n"));

    console.log(
        `✔ #${pr} round ${round}: ${refs.length} threads, ${bodies.length} review bodies, ${commentBodies.length} PR comments in ${dir}`
    );
}
