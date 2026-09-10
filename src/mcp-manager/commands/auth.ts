import { readUnifiedConfig, setGlobalOptions, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { CLIENT_NAME_DEFAULT } from "../lib/auth/constants.ts";
import { loginMcpServer } from "../lib/auth/login.ts";
import { secretPath } from "../lib/auth/paths.ts";
import { isGatewayOauth, serverAuth } from "../lib/auth/policy.ts";
import { oauthClientPresetFor, suggestedLoginCommand } from "../lib/auth/presets.ts";
import { deleteServerTokens, hasSecret, readExpiresAt } from "../lib/auth/secrets.ts";
import { deleteAuthStatus, readAuthStatus } from "../lib/auth/status.ts";
import { peekAccessToken } from "../lib/auth/tokens.ts";
import { ensureGatewayUp } from "../lib/gateway/ensure.ts";

export async function authLogin(
    serverName: string | undefined,
    opts: { device?: boolean; clientName?: string } = {}
): Promise<void> {
    const config = await readUnifiedConfig();
    let name = serverName;

    if (!name) {
        const remotes = Object.entries(config.mcpServers).filter(([, c]) => Boolean(c.url ?? c.httpUrl));

        if (!isInteractive()) {
            logger.error("server name required in non-interactive mode.");
            logger.info(suggestCommand("tools mcp-manager", { replaceCommand: ["auth", "login", "<server>"] }));
            process.exitCode = 1;

            return;
        }

        if (remotes.length === 0) {
            logger.error("No HTTP MCP servers in unified config. Add one with tools mcp-manager install first.");
            process.exitCode = 1;

            return;
        }

        const picked = await p.select({
            message: "Server to log in",
            options: remotes.map(([n, c]) => ({
                value: n,
                label: `${n} (${c.url ?? c.httpUrl})`,
            })),
        });

        if (p.isCancel(picked) || typeof picked !== "string") {
            return;
        }

        name = picked;
    }

    if (!name || !config.mcpServers[name]) {
        logger.error(`Unknown server '${name ?? ""}'. Add it with tools mcp-manager install first.`);
        process.exitCode = 1;

        return;
    }

    const server = config.mcpServers[name];
    const clientName = await resolveClientName(name, server.url ?? server.httpUrl, opts.clientName);

    if (clientName === undefined) {
        return;
    }

    const result = await loginMcpServer({
        server: name,
        config: server,
        device: opts.device,
        clientName,
    });
    const current = config.mcpServers[name];
    setGlobalOptions({ yes: true });
    current.auth = {
        kind: "oauth",
        gateway: true,
        resource: result.resource,
        authorizationServer: result.issuer,
        tokenEndpoint: result.tokenEndpoint,
    };
    await writeUnifiedConfig(config);
    await ensureGatewayUp(config);
    ui.ok(`logged in ${name}`);
    ui.dim(`issuer ${result.issuer}`);
}

async function resolveClientName(
    server: string,
    url: string | undefined,
    explicit?: string
): Promise<string | undefined> {
    const trimmed = explicit?.trim();

    if (trimmed) {
        return trimmed;
    }

    const preset = oauthClientPresetFor(url);

    if (!preset) {
        return CLIENT_NAME_DEFAULT;
    }

    if (!isInteractive()) {
        logger.error(preset.issue);

        for (const choice of preset.clientNames) {
            logger.info(`${choice.value}: ${choice.why}`);
            logger.info(suggestedLoginCommand(server, choice.value));
        }

        process.exitCode = 1;

        return undefined;
    }

    ui.warn(preset.issue);

    for (const choice of preset.clientNames) {
        ui.dim(suggestedLoginCommand(server, choice.value));
    }

    const picked = await p.select({
        message: "OAuth client_name",
        options: [
            ...preset.clientNames.map((choice) => ({
                value: choice.value,
                label: `"${choice.value}"`,
                hint: choice.why,
            })),
            { value: "__default__", label: `"${CLIENT_NAME_DEFAULT}"`, hint: "likely refused" },
            { value: "__abort__", label: "Cancel" },
        ],
    });

    if (p.isCancel(picked) || picked === "__abort__" || typeof picked !== "string") {
        return undefined;
    }

    if (picked === "__default__") {
        return CLIENT_NAME_DEFAULT;
    }

    return picked;
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
