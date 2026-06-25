import { grokAuthPath } from "./paths";

export class GrokAuthExpiredError extends Error {
    readonly authPath: string;
    readonly recoveryHint: string;

    constructor(authPath?: string) {
        const resolvedPath = authPath ?? grokAuthPath();
        const recoveryHint = formatAuthRecoveryHint(resolvedPath);
        super(`Grok session token expired or invalid.\n${recoveryHint}`);
        this.name = "GrokAuthExpiredError";
        this.authPath = resolvedPath;
        this.recoveryHint = recoveryHint;
    }
}

export function formatAuthRecoveryHint(authPath?: string): string {
    const resolvedPath = authPath ?? grokAuthPath();

    return [
        "Run the Grok CLI to refresh auth, then retry:",
        "  grok          # or: grok login",
        `Auth file: ${resolvedPath}`,
    ].join("\n");
}

export { isAuthHttpStatus } from "@app/utils/ai/http-auth";
