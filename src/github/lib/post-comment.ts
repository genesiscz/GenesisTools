import { getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";

export async function postComment(
    owner: string,
    repo: string,
    number: number,
    body: string
): Promise<{ id: number; htmlUrl: string }> {
    const octokit = getOctokit();
    const { data } = await withRetry(
        () => octokit.rest.issues.createComment({ owner, repo, issue_number: number, body }),
        { label: `POST comment on #${number}` }
    );
    return { id: data.id, htmlUrl: data.html_url };
}
