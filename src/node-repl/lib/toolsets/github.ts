import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";

const GITHUB_PR_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const SHORT_PR_REF = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;

/**
 * A GitHub pull request named by its URL or `owner/repo#n`, the two forms hub.pr() takes; github.review() took only
 * `{ owner, repo, number }` and refused a URL (NR27).
 */
export function githubPrRef(ref: string): { owner: string; repo: string; number: number } {
    const match = GITHUB_PR_URL.exec(ref.trim()) ?? SHORT_PR_REF.exec(ref.trim());

    if (!match) {
        throw new Error(
            `"${ref}" is not a GitHub pull request; give its URL (https://github.com/owner/repo/pull/12) or owner/repo#12`
        );
    }

    return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

const review = defineMethod({
    name: "review",
    params: z.union([
        z.object({ ref: z.string().min(1) }).strict(),
        z.object({ owner: z.string().min(1), repo: z.string().min(1), number: z.number().int().positive() }).strict(),
    ]),
    result: z.unknown(),
    resultName: "{ title, state, headRefName, baseRefName, threads: ReviewThread[], prComments }",
    effect: "read",
    doc: "Read a GitHub pull request's review threads and comments. Name it by `ref` (its URL or owner/repo#12, as hub.pr() takes) or by owner, repo and number.",
});

export class GithubToolset extends ReplToolset {
    readonly api = defineApi({
        id: "github",
        global: "github",
        title: "GitHub",
        summary: "Read GitHub pull request reviews.",
        methods: [review],
    });

    async bootstrap(): Promise<Record<string, unknown>> {
        // lazy: saves 27.4 ms cold import (tools ts imports lazy, 2026-11-05) — listing the toolsets loads no Octokit
        const { fetchPRReviewThreads } = await import("@app/github/lib/review-threads");
        return {
            github: {
                review: (input: z.input<typeof review.params>) => {
                    const options = review.params.parse(input);
                    const pr = "ref" in options ? githubPrRef(options.ref) : options;
                    return fetchPRReviewThreads(pr.owner, pr.repo, pr.number);
                },
            },
        };
    }
}
