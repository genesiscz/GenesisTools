#!/usr/bin/env bun
/**
 * Every reviewer's voice on a PR, not only eve's: all reviews by any bot or person, every review thread with its
 * author and whether anyone answered it, every PR comment that is not ours, and every finding a review keeps in its
 * body instead of a thread. It marks what came after the merge, what is still open, and what nobody answered, so a
 * merged PR's late review and a second bot's finding are never missed (2026-10-14: #505 got 3 eve findings after its
 * merge, and the round tooling watched eve and CodeRabbit only).
 *
 *   bun audit-reviews.ts --run <dir> 498 502 503 … [--bodies]
 *
 * --bodies prints the text (first 1200 characters) under each flagged item, and lists every thread that was resolved
 * without a reply: CodeRabbit resolves its own threads when it believes a later commit fixed them, fixed or not.
 *
 * Exit 1 when any PR has an open thread, an unanswered thread, or something that arrived after its merge.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { has, loadRun } from "./run";

interface Comment {
    author?: { login: string };
    createdAt: string;
    body: string;
}

interface Thread {
    id: string;
    isResolved: boolean;
    path: string;
    line?: number;
    comments: { nodes: Comment[] };
}

interface Review extends Comment {
    state: string;
    commit?: { oid: string };
}

interface Pr {
    title: string;
    state: string;
    mergedAt?: string;
    headRefOid: string;
    reviews: { nodes: Review[]; pageInfo: { hasNextPage: boolean } };
    reviewThreads: { nodes: Thread[]; pageInfo: { hasNextPage: boolean } };
    comments: { nodes: Comment[]; pageInfo: { hasNextPage: boolean } };
}

const run = loadRun();
const [owner, name] = run.repo.split("/");
const prs = process.argv.slice(2).filter((a, i, all) => /^\d+$/.test(a) && !all[i - 1]?.startsWith("--"));
const page = "pageInfo{hasNextPage}";
const query = `query($n:Int!){viewer{login} repository(owner:"${owner}",name:"${name}"){pullRequest(number:$n){
 title state mergedAt headRefOid
 reviews(first:100){${page} nodes{author{login} state createdAt:submittedAt body commit{oid}}}
 reviewThreads(first:100){${page} nodes{id isResolved path line comments(first:50){nodes{author{login} createdAt body}}}}
 comments(first:100){${page} nodes{author{login} createdAt body}}}}}`;

const local = (iso: string) =>
    new Date(iso).toLocaleString("cs-CZ", {
        timeZone: "Europe/Prague",
        day: "numeric",
        month: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
const firstLine = (body: string) =>
    body
        .replace(/<[^>]+>/g, " ")
        .split("\n")
        .map((line) => line.replace(/[*_`#>]/g, "").trim())
        .find((line) => line.length > 3)
        ?.slice(0, 110) ?? "";
const bodies = has("--bodies");
const body = (text: string) =>
    bodies
        ? `\n${text
              .replace(/<details>[\s\S]*?<\/details>/g, "")
              .replace(/<[^>]+>/g, "")
              .trim()
              .slice(0, 1200)
              .replace(/^/gm, "      | ")}`
        : "";
let problems = 0;

for (const n of prs) {
    const p = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${query}`, "-F", `n=${n}`], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });

    if (p.exitCode !== 0) {
        console.log(`#${n} ERR ${p.stderr.toString().slice(0, 160)}`);
        problems++;
        continue;
    }

    const data = SafeJSON.parse(p.stdout.toString(), { strict: true }) as {
        data: { viewer: { login: string }; repository: { pullRequest: Pr } };
    };
    const me = data.data.viewer.login;
    const pr = data.data.repository.pullRequest;
    const merged = pr.mergedAt ? Date.parse(pr.mergedAt) : undefined;
    const late = (iso: string) => merged !== undefined && Date.parse(iso) > merged;
    const flags: string[] = [];
    console.log(
        `#${n} ${pr.state}${pr.mergedAt ? ` ${local(pr.mergedAt)}` : ""} head ${pr.headRefOid.slice(0, 9)} ${pr.title.slice(0, 70)}`
    );

    for (const kind of ["reviews", "reviewThreads", "comments"] as const) {
        if (pr[kind].pageInfo.hasNextPage) {
            flags.push(`⚠ more than 100 ${kind}: this audit read only the first 100`);
        }
    }

    const byReviewer = new Map<string, Review[]>();

    for (const review of pr.reviews.nodes) {
        const who = review.author?.login ?? "?";

        if (who !== me) {
            byReviewer.set(who, [...(byReviewer.get(who) ?? []), review]);
        }
    }

    const reviewers = [...byReviewer].map(([who, list]) => {
        const last = list.at(-1);
        const atHead = list.some((r) => r.commit?.oid === pr.headRefOid);
        return `${who} ${list.length}× last ${last?.state} ${last ? local(last.createdAt) : ""}${atHead ? " @head" : ""}`;
    });
    console.log(`  reviewers: ${reviewers.join(" · ") || "none"}`);

    for (const [who, list] of byReviewer) {
        for (const review of list) {
            // Findings a review keeps in its body: CodeRabbit's "outside the diff" and nitpick blocks, a bot's
            // summary that names actionable items. They have no thread, so the round tooling never sees them.
            const actionable = Number(/Actionable comments posted:\s*(\d+)/.exec(review.body)?.[1] ?? 0);
            const outside = /Outside diff range|outside the diff/i.test(review.body);

            if (outside) {
                flags.push(
                    `⚠ ${who} review ${local(review.createdAt)} has findings outside the diff (no thread)${bodies ? `\n${review.body.slice(review.body.search(/Outside diff range|outside the diff/i), review.body.search(/Outside diff range|outside the diff/i) + 1500).replace(/^/gm, "      | ")}` : ""}`
                );
            }

            if (late(review.createdAt) && (review.state !== "APPROVED" || actionable > 0 || outside)) {
                flags.push(
                    `⚠ after merge: ${who} ${review.state} ${local(review.createdAt)} ${firstLine(review.body)}${body(review.body)}`
                );
            }
        }
    }

    let open = 0;
    let unanswered = 0;
    let resolvedSilently = 0;

    for (const thread of pr.reviewThreads.nodes) {
        const [first, ...rest] = thread.comments.nodes;
        const who = first?.author?.login ?? "?";
        const answered = rest.some((c) => c.author?.login !== who);
        const where = `${thread.path}:${thread.line ?? "?"}${bodies ? ` [${thread.id}]` : ""}`;

        if (!thread.isResolved) {
            open++;
        }

        if (!answered) {
            if (thread.isResolved) {
                resolvedSilently++;

                if (bodies) {
                    flags.push(
                        `❗ resolved without a reply, by ${who} ${where}: ${firstLine(first?.body ?? "")}${body(first?.body ?? "")}`
                    );
                }
            } else {
                unanswered++;
                flags.push(
                    `⚠ unanswered open thread by ${who} ${where}: ${firstLine(first?.body ?? "")}${body(first?.body ?? "")}`
                );
            }
        }

        if (first && late(first.createdAt)) {
            flags.push(
                `⚠ after merge: thread by ${who} ${local(first.createdAt)} ${where} ${answered ? "(answered)" : "(NO reply)"}`
            );
        }

        const lastWord = thread.comments.nodes.at(-1);

        if (answered && lastWord && lastWord.author?.login !== me && lastWord.author?.login !== who) {
            flags.push(`❗ ${where}: the last word is from ${lastWord.author?.login}, not from us or ${who}`);
        }
    }

    console.log(
        `  threads: ${pr.reviewThreads.nodes.length} (open ${open}, unanswered ${unanswered}, resolved without a reply ${resolvedSilently})`
    );

    const others = pr.comments.nodes.filter((c) => c.author?.login !== me);
    const counts = new Map<string, number>();

    for (const comment of others) {
        const who = comment.author?.login ?? "?";
        counts.set(who, (counts.get(who) ?? 0) + 1);

        if (late(comment.createdAt)) {
            flags.push(`⚠ after merge: comment by ${who} ${local(comment.createdAt)} ${firstLine(comment.body)}`);
        }
    }

    console.log(`  comments by others: ${[...counts].map(([who, count]) => `${who} ${count}`).join(" · ") || "none"}`);

    for (const line of flags) {
        console.log(`  ${line}`);
    }

    problems += open + unanswered + flags.filter((line) => line.includes("after merge")).length;
}

process.exit(problems > 0 ? 1 : 0);
