#!/usr/bin/env bun
/**
 * One PR round, after the lead has judged the worker commit(s) in the PR's worktree:
 * gates → fast-forward push of the judged SHA → reply file to the vault with the judge → round summary comment (once)
 * → thread replies + resolve. Logs `push` and `post` to the run ledger.
 *
 *   bun integrate.ts --run <dir> --pr 508 --round 1 [--wt <dir>] [--replies <json>] [--session bs-508-r1]
 *                    [--sha-map old=new,…] [--range a..b] [--skip-gates] [--post | --no-post] [--dry] [--no-push-hooks]
 *                    [--restacked-from <old head>]
 *
 * --restacked-from: HEAD was rebased on purpose (restack.ts, merge prep). The push is then forced with a lease on that
 * exact old head, and refused when the remote moved since; the gates check only the PR's own commits after the restack.
 */
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { appendEvent } from "./ledger";
import { isDeferredReply } from "./policy";
import { probeAddedLines } from "./probe";
import { flag, has, loadRun, worktreeFor } from "./run";
import { ensureConfigHooks, HOOKS_OFF, newExecutablesStall } from "./versions";

/** The guards `.githooks/pre-push` runs, label first. Keep this list in step with the hook. */
export const PRE_PUSH_GUARDS: string[][] = [
    ["lint:dashboard", "bun", "run", "lint:dashboard"],
    ["typecheck:all", "bun", "run", "typecheck:all"],
    ["logging-guard", "bash", "scripts/ci/logging-guard.sh"],
    ["ai-credentials-guard", "bash", "scripts/ci/ai-credentials-guard.sh"],
    ["pid-safety-guard", "bash", "scripts/ci/pid-safety-guard.sh"],
    ["package-boundaries", "bun", "scripts/ci/check-package-boundaries.ts"],
    ["plugin-standalone", "bun", "scripts/ci/check-plugin-standalone.ts"],
    ["tool-commands", "bun", "scripts/ci/check-tool-commands.ts", "--strict"],
    ["jev-instrumentation", "bun", "scripts/ci/jev-instrumentation-guard.ts"],
    ["entrypoint-imports", "bun", "scripts/ci/entrypoint-import-guard.ts"],
];

export function postingExitCode(posted: number, followups: Array<{ code: number }>): number {
    return posted === 0 && followups.every((reply) => reply.code === 0) ? 0 : 1;
}

interface ReplyItem {
    ref?: string;
    threadId?: string;
    verdict?: string;
    reply?: string;
}

export function earlierVerdicts(options: { vault: string; pr: string; round: string }): Map<string, string> {
    const result = new Map<string, string>();
    const current = /^(\d+)([a-z]?)$/.exec(options.round);
    if (!current) {
        throw new Error("invalid reply round: " + options.round);
    }
    const currentRound = Number(current[1]);
    const currentSuffix = current[2];
    const names = readdirSync(options.vault)
        .flatMap((name) => {
            const match = /^(\d+)-r(\d+)([a-z]?)-replies\.json$/.exec(name);
            if (!match || match[1] !== options.pr) {
                return [];
            }
            const round = Number(match[2]);
            const suffix = match[3];
            return round < currentRound || (round === currentRound && suffix < currentSuffix)
                ? [{ name, round, suffix }]
                : [];
        })
        .sort((a, b) => a.round - b.round || a.suffix.localeCompare(b.suffix));
    for (const { name } of names) {
        const previous = SafeJSON.parse(readFileSync(join(options.vault, name), "utf8"), { strict: true }) as {
            items?: ReplyItem[];
        };
        for (const item of previous.items ?? []) {
            if (item.threadId && item.verdict) {
                result.set(item.threadId, item.verdict);
            }
        }
    }
    return result;
}

/** A separate Git checkout pins every tracked gate input while the worker continues its next round. */
function gateSnapshot(options: { wt: string; sha: string; runDir: string }): string {
    const snapshots = join(options.runDir, "gate-snapshots");
    mkdirSync(snapshots, { recursive: true });
    const snapshot = mkdtempSync(join(snapshots, options.sha.slice(0, 9) + "-"));
    // A full checkout per round filled the run folder; the gates are done (passed or exited) when the process ends.
    process.on("exit", () => rmSync(snapshot, { recursive: true, force: true }));
    for (const args of [
        ["clone", "--shared", "--no-checkout", "--quiet", options.wt, snapshot],
        ["-C", snapshot, "checkout", "--quiet", "--detach", options.sha],
    ]) {
        const result = Bun.spawnSync(["git", ...HOOKS_OFF, ...args], {
            cwd: options.wt,
            stdout: "pipe",
            stderr: "pipe",
            env: env.getProcessEnv(),
            timeout: 60_000,
        });
        if (result.exitCode !== 0) {
            throw new Error(`gate snapshot failed: ${result.stderr.toString()}`);
        }
    }

    const workerRoot = realpathSync(options.wt);
    // Keep assessed dependency binaries; redirect workspace-package links to the pinned source, never the worker.
    const linkDependencies = (source: string, destination: string) => {
        mkdirSync(destination, { recursive: true });
        for (const name of readdirSync(source)) {
            const input = join(source, name);
            const output = join(destination, name);
            if ((name.startsWith("@") || name === ".bin") && lstatSync(input).isDirectory()) {
                linkDependencies(input, output);
                continue;
            }

            const target = realpathSync(input);
            const local = relative(workerRoot, target);
            const workspace =
                !isAbsolute(local) &&
                local !== ".." &&
                !local.startsWith(".." + sep) &&
                local !== "node_modules" &&
                !local.startsWith("node_modules" + sep);
            symlinkSync(workspace ? resolve(snapshot, local) : target, output);
        }
    };
    const modules = join(options.wt, "node_modules");
    if (existsSync(modules)) {
        linkDependencies(modules, join(snapshot, "node_modules"));
    }

    console.log(`gates: pinned ${options.sha} in ${snapshot}`);
    return snapshot;
}

async function main(): Promise<void> {
    const run = loadRun();
    // This repository's gates (tsgo, lint-rules, check-tool-commands, check-commits) exist only in GenesisTools. Another
    // repository's run card skips them by itself: GenesisPlayground #94 round 1 ran `bunx tsgo` in a Swift app, printed the
    // compiler's help and stopped the push (2026-10-15).
    const skipGates = has("--skip-gates") || run.repo !== "genesiscz/GenesisTools";
    const pr = flag("--pr") ?? "";
    const round = flag("--round") ?? "1";
    const wt = resolve(flag("--wt") ?? worktreeFor(run, pr));
    const session = flag("--session") ?? `bs-${pr}-r${round}`;
    const repliesIn = flag("--replies") ?? join(wt, ".claude/work/babysit", `${pr}-r${round}-replies.json`);
    const shaMap = Object.fromEntries(
        (flag("--sha-map") ?? "")
            .split(",")
            .filter(Boolean)
            .map((pair): [string, string] => {
                const [from = "", to = ""] = pair.split("=");
                return [from, to];
            })
    );
    const dry = has("--dry");

    let executionRoot = wt;
    function exec(cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}): { code: number; out: string } {
        const p = Bun.spawnSync(cmd, {
            cwd: opts.cwd ?? executionRoot,
            stdout: "pipe",
            stderr: "pipe",
            env: env.getProcessEnv(),
        });
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

    const view = must(["gh", "pr", "view", pr, "--repo", run.repo, "--json", "headRefName,baseRefName"], "pr view");
    const { headRefName: branch, baseRefName } = SafeJSON.parse(view, { strict: true }) as {
        headRefName: string;
        baseRefName: string;
    };
    must(["git", "fetch", "-q", "origin", branch, baseRefName], "fetch");
    const oldHead = must(["git", "rev-parse", `origin/${branch}`], "rev-parse").trim();
    const newHead = must(["git", "rev-parse", "HEAD"], "rev-parse HEAD").trim();
    const restackedFrom = flag("--restacked-from");

    if (restackedFrom) {
        // 2026-10-14: #500, #517 and #510 were restacked for landing and integrate refused them as "someone pushed", so the
        // lead pushed by hand. The lease is the old head the lead rebased from: anything newer on the remote is refused.
        const from = must(
            ["git", "rev-parse", "--verify", `${restackedFrom}^{commit}`],
            "rev-parse --restacked-from"
        ).trim();

        if (from !== oldHead) {
            console.log(
                `✖ origin/${branch} is ${oldHead.slice(0, 9)}, not the restacked-from ${from.slice(0, 9)}: someone pushed`
            );
            process.exit(1);
        }
    } else if (exec(["git", "merge-base", "--is-ancestor", oldHead, newHead], { quiet: true }).code !== 0) {
        console.log(
            `✖ HEAD ${newHead.slice(0, 9)} does not contain origin/${branch} ${oldHead.slice(0, 9)}: someone pushed; rebase first`
        );
        process.exit(1);
    }

    // A restack replays the base's commits too: gate only the PR's own commits on top of its base.
    const gateFrom = restackedFrom
        ? must(["git", "merge-base", `origin/${baseRefName}`, newHead], "merge-base").trim()
        : oldHead;

    const dirty = must(["git", "status", "--short", "--untracked-files=no"], "status").trim();

    if (dirty) {
        console.log(`✖ worktree has uncommitted changes:\n${dirty}`);
        process.exit(1);
    }

    if (oldHead !== newHead) {
        executionRoot = gateSnapshot({ wt, sha: newHead, runDir: run.dir });
    }

    if (!skipGates && oldHead !== newHead) {
        // TypeScript 7's native compiler, called directly: `bunx` hangs in /tmp worktrees.
        const tsc = join(
            executionRoot,
            `node_modules/@typescript/typescript-${process.platform}-${process.arch}/lib/tsc`
        );
        must(existsSync(tsc) ? [tsc, "--noEmit"] : ["bunx", "tsc", "--noEmit"], "tsc");
        // Biome by its exit code over the round's changed files: judging it by the tail of its output let a formatting
        // error through to the pre-push hook (2026-10-14, #502 round 6). The main checkout's binary is already assessed.
        const changed = must(
            ["git", "diff", "--name-only", "-z", "--diff-filter=d", `${gateFrom}..${newHead}`],
            "changed files"
        )
            .split("\0")
            .filter((file) => /\.(ts|tsx|js|jsx|json)$/.test(file));

        if (changed.length > 0) {
            const biome = join(run.main, "node_modules/.bin/biome");
            must(
                [
                    existsSync(biome) ? biome : "bunx",
                    ...(existsSync(biome) ? [] : ["biome"]),
                    "check",
                    "--no-errors-on-unmatched",
                    ...changed,
                ],
                "biome"
            );
        }

        must(["bun", "run", "lint:rules"], "lint-rules");
        // The pre-push hook's CI guards, with the same flags (.githooks/pre-push): a judged round that passes a
        // weaker local check is refused at the push (2026-10-16: tool-commands --strict and pid-safety-guard
        // refused #533, #536 and #537 after integrate's own gates had passed).
        for (const [label, ...cmd] of PRE_PUSH_GUARDS) {
            must(cmd, label);
        }
        must(["bash", "scripts/ci/placeholder-check.sh"], "placeholder-check");
        const commits = must(["bun", "scripts/git/check-commits.ts", `${gateFrom}..${newHead}`], "check-commits");

        if (!/0 with a subject to fix/.test(commits)) {
            console.log(`✖ check-commits:\n${commits}`);
            process.exit(1);
        }
    }

    // --skip-gates (another repository's PR) skips the repository rules above, but never the personal-data probe: it runs
    // on the target worktree and blocks only a hit in a line this push adds (probe.ts).
    if (skipGates && oldHead !== newHead && !probeAddedLines({ wt: executionRoot, from: gateFrom, to: newHead })) {
        process.exit(1);
    }

    executionRoot = wt;
    if (oldHead !== newHead && !dry) {
        // Push the SHA that was judged and gated, never HEAD at push time: a worker steered into its next round in the
        // same worktree can commit while the gates run (2026-10-14, #502 round 3 → 4).
        // --no-push-hooks counts only while new executables really stall (versions.ts): the gates above ran the hook's
        // probe, typecheck and repo rules, but its Biome check is then the lead's job.
        console.log(`hooks: ${ensureConfigHooks(run.main)}`);
        const stalled = has("--no-push-hooks") && !skipGates && (await newExecutablesStall());

        if (has("--no-push-hooks") && !stalled) {
            console.log("= --no-push-hooks ignored: new executables start normally, so the push hooks run");
        }

        const hooks = stalled ? HOOKS_OFF : [];
        const lease = restackedFrom ? [`--force-with-lease=refs/heads/${branch}:${oldHead}`] : [];
        must(["git", ...hooks, "push", ...lease, "origin", `${newHead}:refs/heads/${branch}`], "push");
        const pushed = `${oldHead.slice(0, 9)}${restackedFrom ? "..." : ".."}${newHead.slice(0, 9)}`;
        console.log(`✔ pushed ${branch} ${pushed}${restackedFrom ? " (forced, restack)" : ""}`);
        appendEvent(run.dir, {
            kind: "push",
            pr: Number(pr),
            round: Number(round),
            meta: { branch, range: pushed, ...(restackedFrom ? { forced: `lease on ${oldHead.slice(0, 9)}` } : {}) },
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

    const data = SafeJSON.parse(text, { strict: true }) as {
        judge?: string;
        items?: Array<{
            model?: unknown;
            ref?: unknown;
            threadId?: unknown;
            reviewer?: unknown;
            verdict?: unknown;
            deferred?: unknown;
        }>;
    };
    data.judge = run.judge;
    const deferred = (data.items ?? []).filter(isDeferredReply);
    for (const item of deferred) {
        // The installed reply schema predates the policy and rejects extra fields. Its supported refusal verdict
        // carries the deferral and makes CodeRabbit post the reply instead of silently resolving it.
        item.verdict = "belongs-elsewhere";
        delete item.deferred;
        if (typeof item.threadId !== "string" || !item.threadId || typeof item.ref !== "string" || !item.ref) {
            throw new Error("a deferred reply needs its stable threadId and session ref; nothing posted");
        }
    }

    for (const item of data.items ?? []) {
        if (typeof item.model === "string" && item.model.startsWith(run.judge)) {
            delete item.model;
        }

        // A finding from the lead's own or an independent review has no GitHub thread. A `ref` on it made post-replies
        // answer `t1` of a review session that has no such thread (2026-10-14, #519 round 2); the summary still names it.
        if (item.reviewer === "lead" && !item.threadId && item.ref !== undefined) {
            delete item.ref;
        }
    }

    // Named from the PR and round, never from the worker's file name: a reply file called `524-r2.json` made the summary
    // overwrite it, the posted marker point at the summary itself, and the round's summary and replies go unposted
    // (2026-10-15, #524 round 2).
    const replies = join(run.vault, `${pr}-r${round}-replies.json`);
    writeFileSync(replies, `${SafeJSON.stringify(data, null, 2)}\n`);
    const resolvingReplies = deferred.length ? join(run.vault, `${pr}-r${round}-resolvable.json`) : replies;
    const deferredReplies = join(run.vault, `${pr}-r${round}-deferred.json`);
    if (deferred.length) {
        writeFileSync(
            resolvingReplies,
            SafeJSON.stringify({ ...data, items: (data.items ?? []).filter((item) => !isDeferredReply(item)) }, null, 2)
        );
        writeFileSync(deferredReplies, SafeJSON.stringify({ ...data, items: deferred }, null, 2));
    }
    const summary = join(run.vault, `${pr}-r${round}-summary.md`);
    const range = flag("--range") ?? (oldHead !== newHead ? `${gateFrom}..${newHead}` : undefined);
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

    // Check authorization immediately before the first public mutation, after saving the reviewable files.
    if (has("--no-post") || dry || !(run.post === true || has("--post"))) {
        console.log(`held (posting not authorized or disabled): ${summary}`);
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

    const deferredPosted = deferred.length
        ? exec(
              [
                  "bun",
                  join(run.reviewLoopScripts, "post-replies.ts"),
                  session,
                  deferredReplies,
                  "--phase",
                  "final",
                  "--no-resolve",
                  "--delay-ms",
                  "3000",
                  "--cwd",
                  wt,
              ],
              { cwd: run.vault }
          )
        : { code: 0, out: "" };
    if (deferred.length) {
        console.log(deferredPosted.out);
    }
    const posted = exec(
        [
            "bun",
            join(run.reviewLoopScripts, "post-replies.ts"),
            session,
            resolvingReplies,
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
    const earlier = earlierVerdicts({ vault: run.vault, pr, round });
    const followups: Array<{ threadId: string; code: number; out: string }> = [];

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
        followups.push({ threadId: item.threadId, ...reply });
        console.log(
            `${reply.code === 0 ? "✔" : "⚠"} follow-up on ${item.ref ?? item.threadId} (was ${before}, now fixed)`
        );
    }
    console.log(posted.code === 0 ? `✔ #${pr} round ${round} posted` : `⚠ #${pr} post-replies exit ${posted.code}`);
    appendEvent(run.dir, {
        kind: "post",
        pr: Number(pr),
        round: Number(round),
        text: readFileSync(summary, "utf8"),
        meta: {
            replies,
            exitCode: postingExitCode(posted.code, [...followups, deferredPosted]),
            postRepliesExitCode: posted.code,
            followups,
            postReplies: posted.out
                .split("\n")
                .filter((l) => l.startsWith("final:"))
                .join(" "),
        },
    });

    process.exitCode = postingExitCode(posted.code, [...followups, deferredPosted]);
}

if (import.meta.main) {
    await main();
}
