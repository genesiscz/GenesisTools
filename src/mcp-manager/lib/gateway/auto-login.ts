/**
 * The gateway asks for a login instead of only naming the command.
 *
 * A harness that hits a server with no token gets a 401 and, in Claude Code's case,
 * offers an "Authenticate" button that cannot work: it runs Dynamic Client Registration
 * against the GATEWAY's origin, which serves no OAuth metadata at all and answers 404.
 * The login has to happen against the real issuer, which is what mcp-manager's own login
 * does, so the gateway starts that flow itself and tells the client what is happening.
 *
 * Two guards, because the caller is a retrying MCP client and not a person:
 *
 *   in-flight   one browser window per server, however many requests arrive
 *   cooldown    a FAILED login is not retried immediately, or a client that reconnects
 *               every second opens a browser tab every second
 */
import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { logger } from "@genesiscz/utils/logger";
import { serverAuth } from "../auth/policy.ts";
import { oauthClientPresetFor } from "../auth/presets.ts";

export type LoginRequestOutcome = "started" | "in-flight" | "cooling-down";

export interface LoginLauncherDeps {
    /**
     * `report` is called with the authorization URL as soon as the login has one, which
     * is what makes the URL reusable: a banner that fades, a browser window closed by
     * accident, or a second request all need the same link back.
     */
    login: (server: string, report: (url: string, userCode?: string) => void) => Promise<unknown>;
    notify: (server: string) => Promise<void>;
    /**
     * A login held open by ANOTHER process, if any. The in-flight set above only knows
     * logins this process started; a gateway that restarted while one was waiting for
     * its browser callback would otherwise open a second window on the next request.
     */
    pending?: (server: string) => { url?: string; userCode?: string } | undefined;
    onError?: (server: string, error: unknown) => void;
    now?: () => number;
    cooldownMs?: number;
}

export interface LoginLauncher {
    request(server: string): LoginRequestOutcome;
    /** In-flight only. A finished login, successful or not, is not pending. */
    pending(server: string): boolean;
    /** The last authorization URL this process produced for the server, if any. */
    authorizationUrl(server: string): string | undefined;
    /** Device-flow user_code, when the AS did not send verification_uri_complete. */
    userCode(server: string): string | undefined;
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Auto-login cannot finish unattended when DCR needs an interactive client_name
 * (Figma) and none is stored on the server. Callers must not claim a browser is opening.
 */
export function autoLoginRefusal(name: string, server: UnifiedMCPServerConfig): string | undefined {
    const preset = oauthClientPresetFor(server.url ?? server.httpUrl);

    if (!preset) {
        return undefined;
    }

    const stored = serverAuth(server)?.clientName?.trim();

    if (stored) {
        return undefined;
    }

    return `${name} needs an interactive client_name. Run tools mcp-manager auth login ${name}`;
}

export function createLoginLauncher(deps: LoginLauncherDeps): LoginLauncher {
    const now = deps.now ?? Date.now;
    const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const inFlight = new Set<string>();
    const blockedUntil = new Map<string, number>();
    const authorizationUrls = new Map<string, string>();
    const userCodes = new Map<string, string>();

    const forgetAuthorization = (server: string): void => {
        authorizationUrls.delete(server);
        userCodes.delete(server);
    };

    const rememberAuthorization = (server: string, url: string, userCode?: string): void => {
        authorizationUrls.set(server, url);

        if (userCode) {
            userCodes.set(server, userCode);
        } else {
            userCodes.delete(server);
        }
    };

    return {
        pending: (server) => inFlight.has(server),
        authorizationUrl: (server) => authorizationUrls.get(server) ?? deps.pending?.(server)?.url,
        userCode: (server) => userCodes.get(server) ?? deps.pending?.(server)?.userCode,
        request(server) {
            if (inFlight.has(server)) {
                return "in-flight";
            }

            const elsewhere = deps.pending?.(server);

            if (elsewhere) {
                return "in-flight";
            }

            const until = blockedUntil.get(server);

            if (until !== undefined && now() < until) {
                return "cooling-down";
            }

            // A spent URL from a previous attempt must not be echoed while the
            // replacement login is still producing its own.
            forgetAuthorization(server);
            inFlight.add(server);
            // Deliberately not awaited: the caller is answering an HTTP request and must
            // not hold it open for the length of a browser login.
            void (async () => {
                try {
                    try {
                        await deps.notify(server);
                    } catch (error) {
                        logger.warn({ server, error }, "gateway login notification failed; continuing with login");
                    }

                    await deps.login(server, (url, userCode) => rememberAuthorization(server, url, userCode));
                    blockedUntil.delete(server);
                    forgetAuthorization(server);
                } catch (error) {
                    // A failed login starts the cooldown; a successful one does not, so a
                    // token that expires later can be renewed without waiting this out.
                    blockedUntil.set(server, now() + cooldownMs);
                    deps.onError?.(server, error);
                } finally {
                    inFlight.delete(server);
                }
            })();

            return "started";
        },
    };
}
