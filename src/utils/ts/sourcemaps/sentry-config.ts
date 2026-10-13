import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { completeCaChain } from "@genesiscz/utils/net/ca-chain";
import type { SentryLocation } from "./debug-id.ts";

const { log } = logger.scoped("ts:sourcemaps:sentry");

export interface McpServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
}

interface ClaudeConfig {
    mcpServers?: Record<string, McpServerConfig>;
    projects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>;
}

/**
 * A Claude Code MCP server by name, the way Claude Code would pick it for `cwd`: a project entry of
 * `~/.claude.json` for the folder or its nearest parent, then a `.mcp.json` up the tree, then the user-wide
 * entry. Null when none has that name.
 */
export async function claudeMcpServer(
    name: string,
    cwd: string,
    configPath = join(homedir(), ".claude.json")
): Promise<McpServerConfig | null> {
    const config: ClaudeConfig = existsSync(configPath)
        ? (SafeJSON.parse(await readFile(configPath, "utf8"), { strict: true }) as ClaudeConfig)
        : {};
    for (let dir = cwd; ; dir = dirname(dir)) {
        const fromProject = config.projects?.[dir]?.mcpServers?.[name];
        if (fromProject) {
            return fromProject;
        }

        const mcpJson = join(dir, ".mcp.json");
        if (existsSync(mcpJson)) {
            const servers = (SafeJSON.parse(await readFile(mcpJson, "utf8"), { strict: true }) as ClaudeConfig)
                .mcpServers;
            if (servers?.[name]) {
                return servers[name];
            }
        }

        if (dirname(dir) === dir) {
            break;
        }
    }

    return config.mcpServers?.[name] ?? null;
}

function argValue(args: string[], flag: string): string | undefined {
    for (let i = 0; i < args.length; i++) {
        if (args[i]?.startsWith(`${flag}=`)) {
            return args[i]?.slice(flag.length + 1);
        }

        if (args[i] === flag) {
            return args[i + 1];
        }
    }

    return undefined;
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expands `${NAME}` and `${NAME:-fallback}` the way Claude Code does for an MCP entry. A name that is unset and
 * has no fallback expands to "" and is added to `unset`, so a reference is never used as a literal value.
 */
export function expandMcpValue(value: string, unset: string[] = []): string {
    return value.replace(ENV_REFERENCE, (_reference, name: string, fallback: string | undefined) => {
        const current = env.get(name);
        if (current !== undefined && (current !== "" || fallback === undefined)) {
            return current;
        }

        if (fallback !== undefined) {
            return fallback;
        }

        unset.push(name);
        return "";
    });
}

/**
 * Where a `@sentry/mcp-server` (sentry-mcp) entry points: `--host` or SENTRY_HOST, `--access-token` or
 * SENTRY_ACCESS_TOKEN, and a private CA from SENTRY_CA_BUNDLE / NODE_EXTRA_CA_CERTS / CURL_CA_BUNDLE.
 * The token stays in memory and is never logged.
 */
export async function sentryFromMcpServer(
    server: McpServerConfig
): Promise<Pick<SentryLocation, "url" | "token" | "ca">> {
    // The entry is read from JSON, so its ${VAR} references are still unexpanded here.
    const unset: string[] = [];
    const args = (server.args ?? []).map((arg) => expandMcpValue(arg, unset));
    const serverEnv = Object.fromEntries(
        Object.entries(server.env ?? {}).map(([key, value]) => [key, expandMcpValue(value, unset)])
    );
    const hint = unset.length > 0 ? `; it refers to unset variables: ${[...new Set(unset)].join(", ")}` : "";
    // sentry.io only when the entry names no host: a configured host that expands to nothing must not send this
    // token (meant for a self-hosted Sentry) to sentry.io.
    const configuredHost = argValue(args, "--host") ?? serverEnv.SENTRY_HOST;
    if (configuredHost !== undefined && !configuredHost) {
        throw new Error(`the MCP server entry sets an empty Sentry host${hint}`);
    }

    const host = configuredHost || "sentry.io";
    const token = argValue(args, "--access-token") || serverEnv.SENTRY_ACCESS_TOKEN || serverEnv.SENTRY_AUTH_TOKEN;
    if (!token) {
        throw new Error(`the MCP server entry carries no access token (--access-token or SENTRY_ACCESS_TOKEN)${hint}`);
    }

    const caPath = serverEnv.SENTRY_CA_BUNDLE || serverEnv.NODE_EXTRA_CA_CERTS || serverEnv.CURL_CA_BUNDLE;
    const ca = caPath && existsSync(caPath) ? await completeCaChain(await readFile(caPath, "utf8")) : undefined;
    const url = /^https?:\/\//.test(host) ? host : `https://${host}`;
    log.info({ url, ca: Boolean(ca) }, "sentry location from an MCP server entry");
    return { url, token, ca };
}

/** Org and project slugs the token can see, to name in an error when the caller did not give them. */
export async function listSentryScopes(
    location: Pick<SentryLocation, "url" | "token" | "ca">,
    org?: string
): Promise<string[]> {
    const base = location.url.replace(/\/+$/, "");
    const path = org ? `/api/0/organizations/${encodeURIComponent(org)}/projects/` : "/api/0/organizations/";
    const init: RequestInit & { tls?: { ca?: string | string[] } } = {
        headers: { authorization: `Bearer ${location.token}` },
        ...(location.ca ? { tls: { ca: location.ca } } : {}),
    };
    const response = await fetch(`${base}${path}`, init);
    if (!response.ok) {
        throw new Error(`sentry ${path}: HTTP ${response.status}`);
    }

    const items = SafeJSON.parse(await response.text(), { strict: true }) as Array<{ slug?: string }>;
    return items.map((item) => item.slug).filter((slug): slug is string => typeof slug === "string");
}
