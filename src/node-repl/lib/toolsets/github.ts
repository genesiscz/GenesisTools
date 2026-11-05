import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";

const review = defineMethod({
    name: "review",
    params: z.object({ owner: z.string().min(1), repo: z.string().min(1), number: z.number().int().positive() }),
    result: z.unknown(),
    resultName: "PRReviewInfo",
    effect: "read",
    doc: "Read a GitHub pull request's review threads and comments.",
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
                    return fetchPRReviewThreads(options.owner, options.repo, options.number);
                },
            },
        };
    }
}
