import { readUnifiedConfig, setGlobalOptions, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import pc from "picocolors";
import { CLIENT_NAME_DEFAULT } from "../lib/auth/constants.ts";
import { type AuthTokenState, describeAuthStatus } from "../lib/auth/display.ts";
import { DynamicClientRegistrationError, loginMcpServer } from "../lib/auth/login.ts";
import { isGatewayOauth, serverAuth } from "../lib/auth/policy.ts";
import {
    CLIENT_NAME_ABORT,
    clientNameSelectOptions,
    type DcrFailureView,
    oauthClientPresetFor,
    suggestedLoginCommand,
} from "../lib/auth/presets.ts";
import { deleteServerTokens } from "../lib/auth/secrets.ts";
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

    try {
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
    } catch (err) {
        if (err instanceof DynamicClientRegistrationError) {
            printDcrFailure(err.view);
            process.exitCode = 1;

            return;
        }

        throw err;
    }
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

    const picked = await p.select({
        message: "OAuth client_name",
        options: clientNameSelectOptions(preset),
    });

    if (p.isCancel(picked) || picked === CLIENT_NAME_ABORT || typeof picked !== "string") {
        return undefined;
    }

    return picked;
}

function printDcrFailure(view: DcrFailureView): void {
    ui.err(view.title);

    for (const line of view.detail) {
        ui.dim(line);
    }

    if (view.issue) {
        ui.warn(view.issue);
    }

    if (view.retry.length === 0) {
        return;
    }

    ui.info("Retry with a name this server accepts:");

    for (const command of view.retry) {
        ui.dim(`  ${command}`);
    }
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
    const names = serverName ? [serverName] : Object.keys(config.mcpServers).sort();
    const table = createBoxTable(["SERVER", "AUTH", "TOKEN", "EXPIRES"]);
    const loginNeeded: string[] = [];
    let rows = 0;
    let issuer: string | undefined;

    for (const name of names) {
        const server = config.mcpServers[name];

        if (!server) {
            ui.warn(`${name}: not in unified config`);
            continue;
        }

        const peek = await peekAccessToken(name);

        if (!serverName && !isAuthStatusRow(server, Boolean(peek.accessToken))) {
            continue;
        }

        const auth = serverAuth(server);
        const view = describeAuthStatus({
            server: name,
            kind: auth?.kind,
            gateway: isGatewayOauth(server),
            hasAccess: Boolean(peek.accessToken),
            expired: peek.expired,
            expiresAt: peek.expiresAt,
        });

        table.push([pc.white(view.server), view.auth, tokenCell(view.token), view.expires]);
        rows += 1;

        if (view.needsLogin) {
            loginNeeded.push(name);
        }

        if (serverName) {
            const status = await readAuthStatus(name);
            issuer = "issuer" in status ? status.issuer : undefined;
        }
    }

    if (rows === 0) {
        ui.info("No remote MCP servers with auth.");
        ui.dim(
            `login: ${suggestCommand("tools mcp-manager", { replaceCommand: ["auth", "login", serverName ?? "<server>"] })}`
        );

        return;
    }

    renderCliHeader("MCP auth", serverName ?? `${rows} remote server${rows === 1 ? "" : "s"}`);
    out.println(table.toString());

    if (issuer) {
        ui.dim(`issuer ${issuer}`);
    }

    for (const name of loginNeeded) {
        ui.dim(`login: ${suggestCommand("tools mcp-manager", { replaceCommand: ["auth", "login", name] })}`);
    }
}

function isAuthStatusRow(server: UnifiedMCPServerConfig, hasToken: boolean): boolean {
    return Boolean(serverAuth(server) || hasToken);
}

function tokenCell(token: AuthTokenState): string {
    if (token === "live") {
        return formatDotStatus("ok", "live");
    }

    if (token === "expired") {
        return formatDotStatus("warn", "expired");
    }

    if (token === "missing") {
        return formatDotStatus("err", "missing");
    }

    return formatDotStatus("dim", "none");
}
