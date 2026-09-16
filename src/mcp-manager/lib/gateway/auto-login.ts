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
export type LoginRequestOutcome = "started" | "in-flight" | "cooling-down";

export interface LoginLauncherDeps {
    /**
     * `report` is called with the authorization URL as soon as the login has one, which
     * is what makes the URL reusable: a banner that fades, a browser window closed by
     * accident, or a second request all need the same link back.
     */
    login: (server: string, report: (url: string) => void) => Promise<unknown>;
    notify: (server: string) => Promise<void>;
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
}

const DEFAULT_COOLDOWN_MS = 60_000;

export function createLoginLauncher(deps: LoginLauncherDeps): LoginLauncher {
    const now = deps.now ?? Date.now;
    const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const inFlight = new Set<string>();
    const blockedUntil = new Map<string, number>();
    const authorizationUrls = new Map<string, string>();

    return {
        pending: (server) => inFlight.has(server),
        authorizationUrl: (server) => authorizationUrls.get(server),
        request(server) {
            if (inFlight.has(server)) {
                return "in-flight";
            }

            const until = blockedUntil.get(server);

            if (until !== undefined && now() < until) {
                return "cooling-down";
            }

            inFlight.add(server);
            // Deliberately not awaited: the caller is answering an HTTP request and must
            // not hold it open for the length of a browser login.
            void (async () => {
                try {
                    await deps.notify(server);
                    await deps.login(server, (url) => authorizationUrls.set(server, url));
                    blockedUntil.delete(server);
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
