import { grokAuthPath } from "./paths";

export class GrokAuthExpiredError extends Error {
    readonly authPath: string;
    readonly recoveryHint: string;

    /**
     * `cause` carries the error that stopped the OIDC refresh when there was one (a
     * dead network on the way to the token endpoint). The poll gate reads it: a refresh
     * that never reached the issuer is a transport failure, not a dead session.
     */
    constructor(authPath?: string, options?: { cause?: unknown }) {
        const resolvedPath = authPath ?? grokAuthPath();
        const recoveryHint = formatAuthRecoveryHint(resolvedPath);
        super(`Grok session token expired or invalid.\n${recoveryHint}`, options);
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

export { isAuthHttpStatus } from "@genesiscz/utils/ai/http-auth";
