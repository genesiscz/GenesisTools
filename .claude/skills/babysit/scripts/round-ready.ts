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
import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { flag, loadRun } from "./run";

interface Activity {
    id: string;
    updatedAt: string;
    author?: { login: string };
}

interface Review extends Activity {
    commit?: { oid: string };
    submittedAt: string;
    state: string;
}

interface Thread {
    id: string;
    isResolved: boolean;
    comments: { nodes: Array<{ author?: { login: string } }> };
    latest: { nodes: Activity[] };
}

interface Connection<T> {
    nodes: T[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface Pr {
    headRefOid: string;
    reviewThreads: Connection<Thread>;
    comments: Connection<Activity>;
    reviews: Connection<Review>;
    timelineItems: { nodes: Array<{ createdAt?: string }> };
}

interface Response {
    data?: { viewer: { login: string }; repository: { pullRequest: Pr } };
    errors?: Array<{ message: string }>;
}

const run = loadRun();
const [owner, name] = run.repo.split("/");
const only = flag("--bots")?.split(",");
const prs = process.argv.slice(2).filter((a, i, all) => /^\d+$/.test(a) && !all[i - 1]?.startsWith("--"));
const waitMinutes = Number(flag("--wait") ?? 0);
const deadline = Date.now() + (waitMinutes > 0 ? waitMinutes * 60_000 : 120_000);
if (!Number.isFinite(waitMinutes) || waitMinutes < 0 || !Number.isFinite(deadline)) {
    console.error("--wait must be a finite nonnegative duration in minutes");
    process.exit(2);
}
const required = only ?? ["eve-bot-lovinka"];
const pageInfo = "pageInfo{hasNextPage endCursor}";
const query = `query($n:Int!,$threadsCursor:String,$commentsCursor:String,$reviewsCursor:String){viewer{login} repository(owner:"${owner}",name:"${name}"){pullRequest(number:$n){headRefOid
 reviewThreads(first:100,after:$threadsCursor){${pageInfo} nodes{id isResolved comments(first:1){nodes{author{login}}} latest:comments(last:1){nodes{id updatedAt}}}}
 comments(first:100,after:$commentsCursor){${pageInfo} nodes{id updatedAt author{login}}}
 reviews(first:100,after:$reviewsCursor){${pageInfo} nodes{id updatedAt author{login} commit{oid} submittedAt state}}
 timelineItems(last:1,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{createdAt}}}}}}`;

/** Read every connection; an incomplete or inconsistent snapshot is an error, never a ready head. */
function readAll(n: string, deadline: number): { me: string; pr: Pr } {
    const cursors = new Map<string, string>();
    const visited = new Map<string, Set<string>>();
    const finished = new Set<string>();
    const threads: Thread[] = [];
    const comments: Activity[] = [];
    const reviews: Review[] = [];
    let first: Response["data"];
    const append = <T>(key: string, connection: Connection<T>, output: T[]) => {
        if (finished.has(key)) {
            return;
        }

        if (!connection?.pageInfo || !Array.isArray(connection.nodes)) {
            throw new Error(`missing ${key} page information`);
        }

        output.push(...connection.nodes);
        if (!connection.pageInfo.hasNextPage) {
            finished.add(key);
            return;
        }

        const cursor = connection.pageInfo.endCursor;
        const seen = visited.get(key) ?? new Set<string>();
        if (!cursor || seen.has(cursor)) {
            throw new Error(`invalid ${key} pagination cursor`);
        }

        seen.add(cursor);
        visited.set(key, seen);
        cursors.set(key, cursor);
    };

    while (finished.size < 3) {
        if (Date.now() >= deadline) {
            throw new Error("review pagination timed out");
        }

        const p = Bun.spawnSync(
            [
                "gh",
                "api",
                "graphql",
                "-f",
                `query=${query}`,
                "-F",
                `n=${n}`,
                ...[...cursors].flatMap(([key, cursor]) => ["-f", `${key}Cursor=${cursor}`]),
            ],
            {
                stdout: "pipe",
                stderr: "pipe",
                timeout: Math.max(1, Math.min(30_000, deadline - Date.now())),
                killSignal: "SIGKILL",
            }
        );
        if (Date.now() >= deadline) {
            throw new Error("review wait deadline expired");
        }

        if (p.exitCode !== 0) {
            throw new Error(p.stderr.toString().slice(0, 120) || `review read exited ${p.exitCode}`);
        }

        const response = SafeJSON.parse(p.stdout.toString(), { strict: true }) as Response;
        if (!response.data || response.errors?.length) {
            throw new Error(response.errors?.map((error) => error.message).join("; ") || "missing review data");
        }

        first ??= response.data;
        const pr = response.data.repository.pullRequest;
        if (!pr || pr.headRefOid !== first.repository.pullRequest.headRefOid) {
            throw new Error("PR head changed during review pagination");
        }

        append("threads", pr.reviewThreads, threads);
        append("comments", pr.comments, comments);
        append("reviews", pr.reviews, reviews);
    }

    if (!first) {
        throw new Error("missing review snapshot");
    }

    const pr = first.repository.pullRequest;
    pr.reviewThreads.nodes = threads;
    pr.comments.nodes = comments;
    pr.reviews.nodes = reviews;
    return { me: first.viewer.login, pr };
}

/** One line per PR, and whether every required reviewer has reviewed its head. */
function readPr(n: string, deadline: number): { line: string; ready: boolean } {
    let snapshot: ReturnType<typeof readAll>;
    try {
        snapshot = readAll(n, deadline);
    } catch (error) {
        return { line: `#${n} ERR ${String(error).slice(0, 160)}`, ready: false };
    }

    const { me, pr } = snapshot;
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
    // Counts alone hide new activity in capped windows and reviews of older heads.
    const activity = createHash("sha256")
        .update(
            SafeJSON.stringify({
                threads: pr.reviewThreads.nodes,
                comments: pr.comments.nodes.filter((comment) => comment.author?.login !== me),
                reviews: pr.reviews.nodes.filter((review) => review.author?.login !== me),
                forced: pr.timelineItems.nodes,
            })
        )
        .digest("hex")
        .slice(0, 16);
    return {
        line: `#${n} head ${pr.headRefOid.slice(0, 9)} ${atHead.join(" ")} open ${SafeJSON.stringify(open, { strict: true })} comments ${SafeJSON.stringify(comments, { strict: true })} activity ${activity}`,
        ready: required.every((bot) => reviewedHead.has(bot)),
    };
}

let results = prs.map((pr) => readPr(pr, deadline));
while (waitMinutes > 0 && !results.every((r) => r.ready) && Date.now() < deadline) {
    await Bun.sleep(Math.min(120_000, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) {
        break;
    }

    results = prs.map((pr) => readPr(pr, deadline));
}

for (const result of results) {
    console.log(result.line);
}

if (waitMinutes > 0 && (Date.now() >= deadline || !results.every((r) => r.ready))) {
    console.log(`not every head reviewed by ${required.join(", ")} after ${waitMinutes} min`);
    process.exit(3);
}
