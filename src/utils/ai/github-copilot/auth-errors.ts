import { toolCommand } from "@genesiscz/utils/cli/tool-command";

export class CopilotAuthExpiredError extends Error {
    readonly authPath: string;

    constructor(authPath: string) {
        super(`GitHub Copilot auth expired or missing. Run: ${toolCommand("ai-proxy accounts login")} github-copilot`);
        this.name = "CopilotAuthExpiredError";
        this.authPath = authPath;
    }
}

export { isAuthHttpStatus } from "@genesiscz/utils/ai/http-auth";
