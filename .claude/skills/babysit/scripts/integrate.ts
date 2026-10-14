#!/usr/bin/env bun
/**
 * One PR round, after the lead has judged the worker commit(s) in the PR's worktree:
 * gates → fast-forward push of the judged SHA → reply file to the vault with the judge → round summary comment (once)
 * → thread replies + resolve. Logs `push` and `post` to the run ledger.
 *
 *   bun integrate.ts --run <dir> --pr 508 --round 1 [--wt <dir>] [--replies <json>] [--session bs-508-r1]
 *                    [--sha-map old=new,…] [--range a..b] [--skip-gates] [--no-post] [--dry] [--no-push-hooks]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { appendEvent } from "./ledger";
import { flag, has, loadRun, worktreeFor } from "./run";
import { HOOKS_OFF, newExecutablesStall } from "./versions";

const run = loadRun();
const pr = flag("--pr") ?? "";
const round = flag("--round") ?? "1";
const wt = flag("--wt") ?? worktreeFor(run, pr);
const session = flag("--session") ?? `bs-${pr}-r${round}`;
const repliesIn = flag("--replies") ?? join(wt, ".claude/work/babysit", `${pr}-r${round}-replies.json`);
const shaMap = Object.fromEntries(
    (flag("--sha-map") ?? "")
        .split(",")
        .filter(Boolean)
        .map((pair) => pair.split("="))
);
const dry = has("--dry");

function exec(cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}): { code: number; out: string } {
    const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? wt, stdout: "pipe", stderr: "pipe", env: process.env });
    const out = `${p.stdout.toString()}${p.stderr.toString()}`;

    if (!opts.quiet) {
        console.log(`$ ${cmd.join(" ").slice(0, 140)} → exit ${p.exitCode}`);
    }

    return { code: p.exitCode ?? 1, out };
}

function must(cmd: string[], label: string, cwd?: string): string {
    const r = exec(cmd, { cwd });

    if (r.code !== 0) {
        console.log(`✖ ${label} failed:\n${r.out.split("\n").slice(-25).join("\n")}`);
        process.exit(1);
    }

    return r.out;
}

const view = must(["gh", "pr", "view", pr, "--repo", run.repo, "--json", "headRefName"], "pr view");
const branch = (SafeJSON.parse(view, { strict: true }) as { headRefName: string }).headRefName;
must(["git", "fetch", "-q", "origin", branch], "fetch");
const oldHead = must(["git", "rev-parse", `origin/${branch}`], "rev-parse").trim();
const newHead = must(["git", "rev-parse", "HEAD"], "rev-parse HEAD").trim();

if (exec(["git", "merge-base", "--is-ancestor", oldHead, newHead], { quiet: true }).code !== 0) {
    console.log(
        `✖ HEAD ${newHead.slice(0, 9)} does not contain origin/${branch} ${oldHead.slice(0, 9)}: someone pushed; rebase first`
    );
    process.exit(1);
}

const dirty = must(["git", "status", "--short", "--untracked-files=no"], "status").trim();

if (dirty) {
    console.log(`✖ worktree has uncommitted changes:\n${dirty}`);
    process.exit(1);
}

if (!has("--skip-gates") && oldHead !== newHead) {
    const tsgo = join(wt, "node_modules/@typescript/native-preview-darwin-arm64/lib/tsgo");
    must(existsSync(tsgo) ? [tsgo, "--noEmit"] : ["bunx", "tsgo", "--noEmit"], "tsgo");
    // Biome by its exit code over the round's changed files: judging it by the tail of its output let a formatting
    // error through to the pre-push hook (2026-10-14, #502 round 6). The main checkout's binary is already assessed.
    const changed = must(["git", "diff", "--name-only", "--diff-filter=d", `${oldHead}..${newHead}`], "changed files")
        .split("\n")
        .filter((file) => /\.(ts|tsx|js|jsx|json)$/.test(file));

    if (changed.length > 0) {
        const biome = join(run.main, "node_modules/.bin/biome");
        must(
            [existsSync(biome) ? biome : "bunx", ...(existsSync(biome) ? [] : ["biome"]), "check", ...changed],
            "biome"
        );
    }

    must(["bun", "run", "lint:rules"], "lint-rules");
    must(["bun", "scripts/ci/check-tool-commands.ts"], "check-tool-commands");
    must(["bash", "scripts/ci/placeholder-check.sh"], "placeholder-check");
    const commits = must(["bun", "scripts/git/check-commits.ts", `${oldHead}..${newHead}`], "check-commits");

    if (!/0 with a subject to fix/.test(commits)) {
        console.log(`✖ check-commits:\n${commits}`);
        process.exit(1);
    }
}

if (oldHead !== newHead && !dry) {
    // Push the SHA that was judged and gated, never HEAD at push time: a worker steered into its next round in the
    // same worktree can commit while the gates run (2026-10-14, #502 round 3 → 4).
    // --no-push-hooks counts only while new executables really stall (versions.ts): the gates above ran the hook's
    // probe, typecheck and repo rules, but its Biome check is then the lead's job.
    const stalled = has("--no-push-hooks") && !has("--skip-gates") && (await newExecutablesStall());

    if (has("--no-push-hooks") && !stalled) {
        console.log("= --no-push-hooks ignored: new executables start normally, so the push hooks run");
    }

    const hooks = stalled ? HOOKS_OFF : [];
    must(["git", ...hooks, "push", "origin", `${newHead}:refs/heads/${branch}`], "push");
    console.log(`✔ pushed ${branch} ${oldHead.slice(0, 9)}..${newHead.slice(0, 9)}`);
    appendEvent(run.dir, {
        kind: "push",
        pr: Number(pr),
        round: Number(round),
        meta: { branch, range: `${oldHead.slice(0, 9)}..${newHead.slice(0, 9)}` },
    });
} else {
    console.log(oldHead === newHead ? "no new commits: nothing to push" : "dry: push skipped");
}

if (!existsSync(repliesIn)) {
    console.log(`no reply file at ${repliesIn}: nothing to post`);
    process.exit(0);
}

mkdirSync(run.vault, { recursive: true });
let text = readFileSync(repliesIn, "utf8");

for (const [from, to] of Object.entries(shaMap)) {
    text = text.replaceAll(from, to);
}

const data = SafeJSON.parse(text, { strict: true }) as { judge?: string; items?: Array<{ model?: unknown }> };
data.judge = run.judge;

for (const item of data.items ?? []) {
    if (typeof item.model === "string" && item.model.startsWith(run.judge)) {
        delete item.model;
    }
}

const replies = join(run.vault, basename(repliesIn));
writeFileSync(replies, `${SafeJSON.stringify(data, null, 2)}\n`);
const summary = replies.replace(/-replies\.json$/, "-summary.md");
const range = flag("--range") ?? (oldHead !== newHead ? `${oldHead}..${newHead}` : undefined);
must(
    [
        "bun",
        join(run.reviewLoopScripts, "round-summary.ts"),
        replies,
        "--repo",
        run.repo,
        ...(range ? ["--range", range, "--cwd", wt] : []),
        "--out",
        summary,
    ],
    "round-summary",
    run.vault
);

if (has("--no-post") || dry) {
    console.log(`not posted (flag): ${summary}`);
    process.exit(0);
}

// A rerun (a killed push, a retry) must not post the round's summary twice (2026-10-14: #503 got two).
const postedMarker = summary.replace(/\.md$/, ".posted");

if (existsSync(postedMarker)) {
    console.log(`summary already posted (${postedMarker}): skipped`);
} else {
    must(["gh", "pr", "comment", pr, "--repo", run.repo, "--body-file", summary], "summary comment", run.vault);
    writeFileSync(postedMarker, `${new Date().toISOString()}\n`);
}

const posted = exec(
    [
        "bun",
        join(run.reviewLoopScripts, "post-replies.ts"),
        session,
        replies,
        "--phase",
        "final",
        "--resolve-after-s",
        "20",
        "--delay-ms",
        "3000",
        "--cwd",
        wt,
    ],
    { cwd: run.vault }
);
console.log(posted.out.split("\n").slice(-12).join("\n"));

// post-replies counts a thread this run already answered as done, so a later round that FIXES a thread an earlier
// round deferred or refused never reaches the thread (2026-10-14, #502 t4-t7). Reply to those threads directly.
interface ReplyItem {
    ref?: string;
    threadId?: string;
    verdict?: string;
    reply?: string;
}
const earlier = new Map<string, string>();

for (const name of readdirSync(run.vault)) {
    const match = new RegExp(`^${pr}-r(\\d+)[a-z]?-replies\\.json$`).exec(name);

    if (!match || Number(match[1]) >= Number(round)) {
        continue;
    }

    const previous = SafeJSON.parse(readFileSync(join(run.vault, name), "utf8"), { strict: true }) as {
        items?: ReplyItem[];
    };

    for (const item of previous.items ?? []) {
        if (item.threadId && item.verdict) {
            earlier.set(item.threadId, item.verdict);
        }
    }
}

for (const item of (data.items ?? []) as ReplyItem[]) {
    const before = item.threadId ? earlier.get(item.threadId) : undefined;

    if (!item.threadId || item.verdict !== "fixed" || !before || before === "fixed" || !item.reply) {
        continue;
    }

    const mutation = `mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}`;
    const reply = exec(
        [
            "gh",
            "api",
            "graphql",
            "-f",
            `query=${mutation}`,
            "-F",
            `id=${item.threadId}`,
            "-F",
            `body=Round ${round} update: ${item.reply}`,
        ],
        { quiet: true }
    );
    console.log(`${reply.code === 0 ? "✔" : "⚠"} follow-up on ${item.ref ?? item.threadId} (was ${before}, now fixed)`);
}
console.log(posted.code === 0 ? `✔ #${pr} round ${round} posted` : `⚠ #${pr} post-replies exit ${posted.code}`);
appendEvent(run.dir, {
    kind: "post",
    pr: Number(pr),
    round: Number(round),
    text: readFileSync(summary, "utf8"),
    meta: {
        replies,
        postReplies: posted.out
            .split("\n")
            .filter((l) => l.startsWith("final:"))
            .join(" "),
    },
});
