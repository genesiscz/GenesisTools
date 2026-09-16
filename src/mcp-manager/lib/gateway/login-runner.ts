/**
 * The real login the gateway starts when a server has no usable token.
 *
 * Kept out of server.ts so the request handler stays a request handler, and so the
 * launcher's guards (one browser per server, cooldown after a failure) can be tested
 * without a browser, a vault or an authorization server.
 */
import { readUnifiedConfig, setGlobalOptions, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import { loginMcpServer } from "../auth/login.ts";
import { createLoginLauncher, type LoginLauncher } from "./auto-login.ts";

async function runLogin(server: string, report: (url: string) => void): Promise<void> {
    const config = await readUnifiedConfig();
    const stored = config.mcpServers[server];

    if (!stored) {
        throw new Error(`${server} is not in the unified config`);
    }

    const result = await loginMcpServer({
        server,
        config: stored,
        onAuthorizationUrl: async (url) => {
            report(url);
            await notifyLoginUrl(server, url);
        },
    });
    // Persist what the login discovered, or the next request finds no tokenEndpoint,
    // decides the server needs a login, and opens the browser again forever.
    const fresh = await readUnifiedConfig();
    const entry = fresh.mcpServers[server];

    if (!entry) {
        return;
    }

    entry.auth = {
        ...entry.auth,
        kind: "oauth",
        gateway: true,
        resource: result.resource,
        authorizationServer: result.issuer,
        tokenEndpoint: result.tokenEndpoint,
    };
    // The gateway has no terminal to confirm at, and this write is the direct result of
    // a login the user just completed in their browser.
    setGlobalOptions({ yes: true });
    await writeUnifiedConfig(fresh);
}

/** One id per server, so the second post REPLACES the first banner rather than stacking. */
function notificationId(server: string): string {
    return `mcp-gateway-login-${server}`;
}

async function notifyLogin(server: string): Promise<void> {
    await sendNotification({
        title: "MCP login needed",
        message: `${server} needs you to sign in. A browser window is opening.`,
        group: "mcp-gateway-login",
        id: notificationId(server),
    });
}

/**
 * Replace the "opening" banner with one that carries the link.
 *
 * A macOS banner set to "Temporary" fades in about five seconds, and the browser window
 * it announced is easy to close by accident. Without the URL on the notification the only
 * way back is a fresh login, which registers another OAuth client and invalidates the
 * window that may still be open. Clicking the body, or the button, re-opens the same one.
 */
async function notifyLoginUrl(server: string, url: string): Promise<void> {
    await sendNotification({
        title: "MCP login needed",
        message: `${server} is waiting for you to sign in. Click to open the login page.`,
        subtitle: new URL(url).host,
        group: "mcp-gateway-login",
        id: notificationId(server),
        open: url,
        actions: [{ id: "open-login", title: "Open login", open: url }],
    });
}

/** Module-level on purpose: the guards are per gateway process, not per request. */
export const gatewayLoginLauncher: LoginLauncher = createLoginLauncher({
    login: runLogin,
    notify: notifyLogin,
    onError: (server, error) => {
        logger.warn({ server, error }, "gateway-initiated MCP login failed");
    },
});
