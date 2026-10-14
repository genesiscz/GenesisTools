#!/usr/bin/env bun
/**
 * Per PR: the head, whether each reviewer reviewed that head, the unresolved threads per author, and the PR comments
 * per author that are not ours. Every reviewer counts by default, not only eve: a second bot's review or a comment
 * from a person is a reason to look as much as eve's (Martin, 2026-10-14). `--bots` narrows the list.
 * A PR is ready for its next round when the reviewer bot has reviewed the current head.
 *
 *   bun round-ready.ts --run <dir> 499 504 …   [--bots eve-bot-lovinka,coderabbitai]
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
const query = `query($n:Int!){viewer{login} repository(owner:"${owner}",name:"${name}"){pullRequest(number:$n){headRefOid
 reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}}
 comments(last:100){nodes{author{login}}}
 reviews(last:40){nodes{author{login} commit{oid} submittedAt state}}}}}`;

for (const n of prs) {
    const p = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${query}`, "-F", `n=${n}`], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (p.exitCode !== 0) {
        console.log(`#${n} ERR ${p.stderr.toString().slice(0, 120)}`);
        continue;
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

    const atHead = reviewers.map((bot) => {
        // The LATEST review of the head: eve can approve a head and later withhold the approval on it (#503,
        // 2026-10-14: APPROVED 04:48Z, then COMMENTED "approval withheld" 04:53Z), and the first match hid that.
        const review = pr.reviews.nodes.findLast((r) => r.author?.login === bot && r.commit?.oid === pr.headRefOid);
        return `${bot.split("-")[0]}@head ${review ? `${review.state}@${review.submittedAt.slice(11, 16)}Z` : "no"}`;
    });
    console.log(
        `#${n} head ${pr.headRefOid.slice(0, 9)} ${atHead.join(" ")} open ${SafeJSON.stringify(open, { strict: true })} comments ${SafeJSON.stringify(comments, { strict: true })}`
    );
}
