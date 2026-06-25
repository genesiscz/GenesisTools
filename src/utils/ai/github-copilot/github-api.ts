import { COPILOT_STATIC_HEADERS } from "@app/utils/ai/github-copilot/headers";
import { ApiClient } from "@app/utils/api/ApiClient";

const GITHUB_API_BASE = "https://api.github.com";

export function createGithubApiClient(): ApiClient {
    return new ApiClient({
        baseUrl: GITHUB_API_BASE,
        userAgent: COPILOT_STATIC_HEADERS["User-Agent"],
        headers: {
            Accept: "application/vnd.github+json",
        },
        loggerContext: { component: "GithubApi" },
    });
}

/** Shared client for api.github.com (token exchange, user profile, copilot_internal). */
export const githubApi = createGithubApiClient();
