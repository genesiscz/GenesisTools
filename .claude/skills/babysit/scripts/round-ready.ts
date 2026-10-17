#!/usr/bin/env bun
/**
 * Per PR: the head, whether each reviewer reviewed that head, the unresolved threads per author, and the PR comments
 * per author that are not ours. Every reviewer counts by default, not only eve: a second bot's review or a comment
 * from a person is a reason to look as much as eve's (Martin, 2026-10-14). `--bots` narrows the list.
 * A PR is ready for its next round when the reviewer bot has reviewed the current head.
 *
 *   bun round-ready.ts --run <dir> 499 504 …   [--bots eve-bot-lovinka,coderabbitai] [--wait <minutes>]
 *
 * `--wait` blocks, one read every 2 minutes, until each PR's head is reviewed by eve (or by every bot `--bots` names),
 * then prints the lines and exits 0; at the deadline it prints the last lines and exits 3. Use it instead of a one-off
 * waiter that greps this output: one such waiter matched "eve@head yes", a form this script never prints, and sat out
 * its whole 90 minutes while eve had reviewed the head after 6 (2026-10-14, GenesisPlayground #94).
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { flag, loadRun } from "./run";

interface Review {
    author?: { login: string };
    commit?: { oid: string };
    submittedAt: string;
    state: string;
}

const run = loadRun();
const [owner, name] = run.repo.split("/");
const only = flag("--bots")?.split(",");
const prs = process.argv.slice(2).filter((a, i, all) => /^\d+$/.test(a) && !all[i - 1]?.startsWith("--"));
const waitMinutes = Number(flag("--wait") ?? 0);
const required = only ?? ["eve-bot-lovinka"];
const query = `query($n:Int!){viewer{login} repository(owner:"${owner}",name:"${name}"){pullRequest(number:$n){headRefOid
 reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}}
 comments(last:100){nodes{author{login}}}
 reviews(last:40){nodes{author{login} commit{oid} submittedAt state}}
 timelineItems(last:1,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{createdAt}}}}}}`;

/** One line per PR, and whether every required reviewer has reviewed its head. */
function readPr(n: string): { line: string; ready: boolean } {
    const p = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${query}`, "-F", `n=${n}`], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (p.exitCode !== 0) {
        return { line: `#${n} ERR ${p.stderr.toString().slice(0, 120)}`, ready: false };
    }

    const data = (
        SafeJSON.parse(p.stdout.toString(), { strict: true }) as {
            data: {
                viewer: { login: string };
                repository: {
                    pullRequest: {
                        headRefOid: string;
                        reviewThreads: {
                            nodes: Array<{
                                isResolved: boolean;
                                comments: { nodes: Array<{ author?: { login: string } }> };
                            }>;
                        };
                        comments: { nodes: Array<{ author?: { login: string } }> };
                        reviews: { nodes: Review[] };
                        timelineItems: { nodes: Array<{ createdAt?: string }> };
                    };
                };
            };
        }
    ).data;
    const me = data.viewer.login;
    const pr = data.repository.pullRequest;
    const open: Record<string, number> = {};

    for (const thread of pr.reviewThreads.nodes) {
        if (!thread.isResolved) {
            const author = thread.comments.nodes[0]?.author?.login ?? "?";
            open[author] = (open[author] ?? 0) + 1;
        }
    }

    // eve first, then every other reviewer in the order they first reviewed.
    const reviewers = [...new Set(["eve-bot-lovinka", ...pr.reviews.nodes.map((r) => r.author?.login ?? "?")])].filter(
        (login) => login !== me && (only ? only.includes(login) : true)
    );
    const comments: Record<string, number> = {};

    for (const comment of pr.comments.nodes) {
        const author = comment.author?.login ?? "?";

        if (author !== me) {
            comments[author] = (comments[author] ?? 0) + 1;
        }
    }

    const reviewedHead = new Set<string>();
    const atHead = reviewers.map((bot) => {
        // The LATEST review of the head: eve can approve a head and later withhold the approval on it (#503,
        // 2026-10-14: APPROVED 04:48Z, then COMMENTED "approval withheld" 04:53Z), and the first match hid that.
        // After a force-push GitHub reports an earlier review on the NEW head commit when the patch matches, so
        // commit equality is not proof the reviewer saw this tree (2026-10-14: #500 and #517 showed eve@head
        // APPROVED from before their rebase). A review counts only when it is newer than the last force-push.
        const forcedAt = pr.timelineItems.nodes.at(-1)?.createdAt ?? "";
        const review = pr.reviews.nodes.findLast(
            (r) => r.author?.login === bot && r.commit?.oid === pr.headRefOid && r.submittedAt > forcedAt
        );
        if (review) {
            reviewedHead.add(bot);
        }

        return `${bot.split("-")[0]}@head ${review ? `${review.state}@${review.submittedAt.slice(11, 16)}Z` : "no"}`;
    });
    return {
        line: `#${n} head ${pr.headRefOid.slice(0, 9)} ${atHead.join(" ")} open ${SafeJSON.stringify(open, { strict: true })} comments ${SafeJSON.stringify(comments, { strict: true })}`,
        ready: required.every((bot) => reviewedHead.has(bot)),
    };
}

const deadline = Date.now() + waitMinutes * 60_000;
let results = prs.map(readPr);
while (waitMinutes > 0 && !results.every((r) => r.ready) && Date.now() < deadline) {
    await Bun.sleep(Math.min(120_000, Math.max(0, deadline - Date.now())));
    results = prs.map(readPr);
}

for (const result of results) {
    console.log(result.line);
}

if (waitMinutes > 0 && !results.every((r) => r.ready)) {
    console.log(`not every head reviewed by ${required.join(", ")} after ${waitMinutes} min`);
    process.exit(3);
}
