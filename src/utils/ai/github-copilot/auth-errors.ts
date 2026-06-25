export class CopilotAuthExpiredError extends Error {
    readonly authPath: string;

    constructor(authPath: string) {
        super(`GitHub Copilot auth expired or missing. Run: tools ai-proxy accounts login github-copilot`);
        this.name = "CopilotAuthExpiredError";
        this.authPath = authPath;
    }
}

export { isAuthHttpStatus } from "@app/utils/ai/http-auth";
