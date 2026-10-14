#!/usr/bin/env bun
/**
 * Per PR: the head, whether eve and CodeRabbit reviewed that head, and the unresolved threads per author.
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
const bots = (flag("--bots") ?? "eve-bot-lovinka,coderabbitai").split(",");
const prs = process.argv.slice(2).filter((a, i, all) => /^\d+$/.test(a) && !all[i - 1]?.startsWith("--"));
const query = `query($n:Int!){repository(owner:"${owner}",name:"${name}"){pullRequest(number:$n){headRefOid
 reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}}
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

    const pr = (
        SafeJSON.parse(p.stdout.toString(), { strict: true }) as {
            data: {
                repository: {
                    pullRequest: {
                        headRefOid: string;
                        reviewThreads: {
                            nodes: Array<{
                                isResolved: boolean;
                                comments: { nodes: Array<{ author?: { login: string } }> };
                            }>;
                        };
                        reviews: { nodes: Review[] };
                    };
                };
            };
        }
    ).data.repository.pullRequest;
    const open: Record<string, number> = {};

    for (const thread of pr.reviewThreads.nodes) {
        if (!thread.isResolved) {
            const author = thread.comments.nodes[0]?.author?.login ?? "?";
            open[author] = (open[author] ?? 0) + 1;
        }
    }

    const atHead = bots.map((bot) => {
        const review = pr.reviews.nodes.find((r) => r.author?.login === bot && r.commit?.oid === pr.headRefOid);
        return `${bot.split("-")[0]}@head ${review ? `${review.state}@${review.submittedAt.slice(11, 16)}Z` : "no"}`;
    });
    console.log(
        `#${n} head ${pr.headRefOid.slice(0, 9)} ${atHead.join(" ")} open ${SafeJSON.stringify(open, { strict: true })}`
    );
}
