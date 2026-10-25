import { readUnifiedConfig, setGlobalOptions, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import pc from "picocolors";
import { CLIENT_NAME_DEFAULT } from "../lib/auth/constants.ts";
import { type AuthTokenState, describeAuthStatus } from "../lib/auth/display.ts";
import { DynamicClientRegistrationError, loginMcpServer, staticRedirectUriFor } from "../lib/auth/login.ts";
import { isGatewayOauth, policyFor, serverAuth } from "../lib/auth/policy.ts";
import {
    CLIENT_NAME_ABORT,
    clientNameSelectOptions,
    type DcrFailureView,
    oauthClientPresetFor,
    suggestedLoginCommand,
} from "../lib/auth/presets.ts";
import { deleteServerTokens, hasStaticClient, writeStaticClient } from "../lib/auth/secrets.ts";
import { deleteAuthStatus, readAuthStatus } from "../lib/auth/status.ts";
import { accessTokenForRequest, peekAccessToken } from "../lib/auth/tokens.ts";
import { staticClientRefusal } from "../lib/gateway/auto-login.ts";
import { ensureGatewayUp } from "../lib/gateway/ensure.ts";
import { runLogin } from "../lib/gateway/login-runner.ts";
import { clearPendingLogin, takeLivePendingLogin, writePendingLogin } from "../lib/gateway/login-state.ts";

export async function authLogin(
    serverName: string | undefined,
    opts: { device?: boolean; clientName?: string; worker?: boolean } = {}
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
            logger.error(
                `No HTTP MCP servers in unified config. Add one with ${toolCommand("mcp-manager install")} first.`
            );
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
        logger.error(`Unknown server '${name ?? ""}'. Add it with ${toolCommand("mcp-manager install")} first.`);
        process.exitCode = 1;

        return;
    }

    const server = config.mcpServers[name];
    const held = takeLivePendingLogin(name);

    if (held && held.identity.pid !== process.pid) {
        ui.warn(`a login for ${name} is already in flight`);
        if (held.url) {
            ui.dim(held.url);
        }
        return;
    }

    const staticRefusal = await staticClientRefusal(name, server);

    if (staticRefusal) {
        ui.err(staticRefusal);
        process.exitCode = 1;

        return;
    }

    const clientName = await resolveClientName(name, server.url ?? server.httpUrl, opts.clientName);

    if (clientName === undefined) {
        return;
    }

    // Loopback OAuth lives in a detached --worker child so a killed CLI parent
    // (agent timeout, Ctrl-C of the waiter) cannot take the callback port with it.
    // Device flow has no loopback listener; keep it in-process.
    if (!opts.worker && !opts.device) {
        await runLogin(
            name,
            async (url, userCode) => {
                ui.dim(url);
                if (userCode) {
                    ui.kv("code", userCode);
                }
            },
            clientName
        );
        return;
    }

    // Recorded BEFORE discovery and registration, not when the URL appears: the gateway
    // decides whether to start a login by this record, and a request arriving during the
    // registration round trip would otherwise start a second one.
    await writePendingLogin({ server: name, pid: process.pid });

    try {
        const result = await loginMcpServer({
            server: name,
            config: server,
            device: opts.device,
            clientName,
            onAuthorizationUrl: async (url, userCode) => {
                await writePendingLogin({ server: name, pid: process.pid, url, userCode });

                if (userCode) {
                    ui.dim(url);
                    ui.kv("code", userCode);
                }
            },
        });
        const current = config.mcpServers[name];
        setGlobalOptions({ yes: true });
        current.auth = {
            ...current.auth,
            kind: "oauth",
            gateway: true,
            resource: result.resource,
            authorizationServer: result.issuer,
            tokenEndpoint: result.tokenEndpoint,
            clientName,
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
    } finally {
        clearPendingLogin(name, process.pid);
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

/**
 * Store a pre-registered OAuth app for a server without dynamic registration (HubSpot).
 *
 * The secret comes from a hidden prompt, or from stdin when stdin is not a terminal. It is
 * never an argument, so it stays out of shell history and `ps`, and it goes to the vault only:
 * the unified config gets the policy and the redirect URL, which are not secret.
 */
export async function authClient(
    serverName: string | undefined,
    opts: { clientId?: string; redirectUri?: string } = {}
): Promise<void> {
    const config = await readUnifiedConfig();
    const server = serverName ? config.mcpServers[serverName] : undefined;

    if (!serverName || !server) {
        logger.error(`Unknown server '${serverName ?? ""}'. Add it with ${toolCommand("mcp-manager install")} first.`);
        process.exitCode = 1;

        return;
    }

    if (!(server.url ?? server.httpUrl)) {
        logger.error(`${serverName} has no HTTP url. A static OAuth client only applies to a remote server.`);
        process.exitCode = 1;

        return;
    }

    const clientId = opts.clientId?.trim();

    if (!clientId) {
        logger.error(
            `--client-id is required: ${toolCommand("mcp-manager auth client", serverName, "--client-id", "<id>")}`
        );
        process.exitCode = 1;

        return;
    }

    const redirectUri = opts.redirectUri?.trim() || staticRedirectUriFor(server);
    const redirectProblem = loopbackRedirectProblem(redirectUri);

    if (redirectProblem) {
        logger.error(redirectProblem);
        process.exitCode = 1;

        return;
    }

    const clientSecret = await readClientSecret(serverName);

    if (clientSecret === undefined) {
        return;
    }

    if (!clientSecret) {
        logger.error("The client secret is empty. Pipe it on stdin or type it at the hidden prompt.");
        process.exitCode = 1;

        return;
    }

    await writeStaticClient(serverName, { clientId, clientSecret });
    setGlobalOptions({ yes: true });
    server.auth = {
        ...server.auth,
        kind: "oauth",
        gateway: true,
        policy: "static-client",
        redirectUri,
    };
    await writeUnifiedConfig(config);
    ui.ok(`stored the OAuth client for ${serverName}`);
    ui.kv("client", clientId);
    ui.kv("redirect", redirectUri);
    ui.dim("The provider must list this exact redirect URL.");
    ui.dim(`next: ${toolCommand("mcp-manager auth login", serverName)}`);
}

async function readClientSecret(server: string): Promise<string | undefined> {
    if (!process.stdin.isTTY) {
        return (await Bun.stdin.text()).trim();
    }

    const typed = await p.password({ message: `Client secret for ${server}` });

    if (p.isCancel(typed) || typeof typed !== "string") {
        return undefined;
    }

    return typed.trim();
}

/** The callback listener binds this URL, so it must be a loopback http URL with an explicit port. */
function loopbackRedirectProblem(redirectUri: string): string | undefined {
    let url: URL;

    try {
        url = new URL(redirectUri);
    } catch {
        return `--redirect-uri is not a URL: ${redirectUri}`;
    }

    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) {
        return `--redirect-uri must be http://127.0.0.1:<port>/<path> (loopback, explicit port), not ${redirectUri}`;
    }

    return undefined;
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

    const config = await readUnifiedConfig();
    const server = config.mcpServers[serverName];
    const auth = serverAuth(server);
    const configuredUrl = server?.url ?? server?.httpUrl;

    if (!auth?.tokenEndpoint || !auth.resource || !configuredUrl) {
        logger.error(`Run ${toolCommand("mcp-manager auth login", serverName)} first`);
        process.exitCode = 1;

        return;
    }

    await accessTokenForRequest(serverName, {
        tokenEndpoint: auth.tokenEndpoint,
        resource: auth.resource,
        trustBaseline: configuredUrl,
        allowRefresh: true,
    });
    ui.ok(`refreshed ${serverName}`);
}

export async function authStatus(serverName: string | undefined): Promise<void> {
    const config = await readUnifiedConfig();
    const names = serverName ? [serverName] : Object.keys(config.mcpServers).sort();
    const table = createBoxTable(["SERVER", "AUTH", "TOKEN", "EXPIRES"]);
    const loginNeeded: string[] = [];
    const staticClients: Array<{ name: string; redirectUri: string; stored: boolean }> = [];
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

        if (policyFor(server) === "static-client") {
            staticClients.push({
                name,
                redirectUri: staticRedirectUriFor(server),
                stored: await hasStaticClient(name),
            });
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

    for (const client of staticClients) {
        ui.dim(`${client.name} redirect URL (register it with the provider): ${client.redirectUri}`);

        if (!client.stored) {
            ui.warn(
                `${client.name} has no stored OAuth client: ${toolCommand("mcp-manager auth client", client.name, "--client-id", "<id>")}`
            );
        }
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
