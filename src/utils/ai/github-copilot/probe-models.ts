import { GithubCopilotApi } from "@app/utils/ai/github-copilot/api";
import { fetchCopilotModels } from "@app/utils/ai/github-copilot/models";
import { resolveGithubCopilotGhoToken } from "@app/utils/ai/github-copilot/token";
import type { CopilotModelRecord } from "@app/utils/ai/github-copilot/types";

export interface ProbeCopilotModelsOptions {
    dataDir: string;
    apiBaseUrl?: string;
}

export async function probeCopilotModels(options: ProbeCopilotModelsOptions): Promise<CopilotModelRecord[]> {
    const resolved = await resolveGithubCopilotGhoToken({
        dataDir: options.dataDir,
        allowKeychain: true,
    });
    if (!resolved?.token) {
        return [];
    }

    const client = new GithubCopilotApi({
        dataDir: options.dataDir,
        apiBaseUrl: options.apiBaseUrl,
    });

    return fetchCopilotModels(client);
}
