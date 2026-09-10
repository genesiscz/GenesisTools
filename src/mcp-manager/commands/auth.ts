import { readUnifiedConfig, setGlobalOptions, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { loginMcpServer } from "../lib/auth/login.ts";
import { secretPath } from "../lib/auth/paths.ts";
import { isGatewayOauth, serverAuth } from "../lib/auth/policy.ts";
import { deleteServerTokens, hasSecret, readExpiresAt } from "../lib/auth/secrets.ts";
import { deleteAuthStatus, readAuthStatus } from "../lib/auth/status.ts";
import { peekAccessToken } from "../lib/auth/tokens.ts";
import { ensureGatewayUp } from "../lib/gateway/ensure.ts";

export async function authLogin(serverName: string | undefined, opts: { device?: boolean } = {}): Promise<void> {
    const config = await readUnifiedConfig();
    let name = serverName;

    if (!name) {
        const oauth = Object.entries(config.mcpServers).filter(([, c]) => serverAuth(c)?.kind === "oauth");

        if (!isInteractive()) {
            logger.error("server name required in non-interactive mode.");
            logger.info(suggestCommand("tools mcp-manager", { replaceCommand: ["auth", "login", "<server>"] }));
            process.exitCode = 1;

            return;
        }

        name = oauth[0]?.[0];
    }

    if (!name || !config.mcpServers[name]) {
        logger.error(`Unknown server '${name ?? ""}'. Add it with tools mcp-manager install first.`);
        process.exitCode = 1;

        return;
    }

    const result = await loginMcpServer({ server: name, config: config.mcpServers[name], device: opts.device });
    const current = config.mcpServers[name];
    setGlobalOptions({ yes: true });
    current.auth = {
        kind: "oauth",
        gateway: true,
        policy: serverAuth(current)?.policy,
        clientName: serverAuth(current)?.clientName,
        resource: result.resource,
        authorizationServer: result.issuer,
        tokenEndpoint: result.tokenEndpoint,
    };
    await writeUnifiedConfig(config);
    await ensureGatewayUp(config);
    ui.ok(`logged in ${name}`);
    ui.dim(`issuer ${result.issuer}`);
}

export async function authLogout(serverName: string | undefined): Promise<void> {
    if (!serverName) {
        logger.error("server name required");
        process.exitCode = 1;

        return;
    }

    await deleteServerTokens(serverName);
    await deleteAuthStatus(serverName);
    ui.ok(`logged out ${serverName}`);
}

export async function authRefresh(serverName: string | undefined): Promise<void> {
    if (!serverName) {
        logger.error("server name required");
        process.exitCode = 1;

        return;
    }

    const { accessTokenForRequest } = await import("../lib/auth/tokens.ts");
    const config = await readUnifiedConfig();
    const auth = serverAuth(config.mcpServers[serverName]);

    if (!auth?.tokenEndpoint || !auth.resource) {
        logger.error(`Run tools mcp-manager auth login ${serverName} first`);
        process.exitCode = 1;

        return;
    }

    await accessTokenForRequest(serverName, {
        tokenEndpoint: auth.tokenEndpoint,
        resource: auth.resource,
        allowRefresh: true,
    });
    ui.ok(`refreshed ${serverName}`);
}

export async function authStatus(serverName: string | undefined): Promise<void> {
    const config = await readUnifiedConfig();
    const names = serverName ? [serverName] : Object.keys(config.mcpServers);

    for (const name of names) {
        const server = config.mcpServers[name];

        if (!server) {
            ui.warn(`${name}: not in unified config`);
            continue;
        }

        const auth = serverAuth(server);
        const peek = await peekAccessToken(name);
        const status = await readAuthStatus(name);
        const hasAccess = await hasSecret(secretPath(name, "access-token"));
        const expiresAt = await readExpiresAt(name);

        ui.kv(
            name,
            [
                `kind ${auth?.kind ?? "none"}`,
                `gateway ${isGatewayOauth(server) ? "yes" : "no"}`,
                `vault ${hasAccess ? "token" : "empty"}`,
                peek.expired ? "expired" : peek.accessToken ? "live" : "missing",
                expiresAt ? new Date(expiresAt).toISOString() : "",
            ]
                .filter(Boolean)
                .join(" · ")
        );

        if (isGatewayOauth(server) && (!peek.accessToken || peek.expired)) {
            ui.dim(`    fix: tools mcp-manager auth login ${name}`);
        }

        void status;
    }
}
