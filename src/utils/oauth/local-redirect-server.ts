/**
 * Placeholder for OAuth authorization-code flows that need a localhost redirect.
 * GitHub Copilot uses device flow today; this module exists for future providers.
 */

export interface LocalRedirectServerOptions {
    port?: number;
    path?: string;
    timeoutMs?: number;
}

export async function waitForOAuthCode(_options: LocalRedirectServerOptions = {}): Promise<string> {
    throw new Error("Local redirect OAuth is not implemented yet");
}
