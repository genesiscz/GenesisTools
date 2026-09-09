import path from "node:path";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import type { HarnessSyncDirection, HarnessSyncMap, MCPProviderName } from "@app/mcp-manager/utils/types.js";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

export const DEFAULT_HARNESS_HOMES: Record<MCPProviderName, string[]> = {
    claude: ["~/.claude.json"],
    gemini: ["~/.gemini/settings.json"],
    cursor: ["~/.cursor/mcp.json"],
    codex: ["~/.codex"],
};

const HARNESS_NAMES: MCPProviderName[] = ["claude", "gemini", "cursor", "codex"];

function hasHomes(direction?: HarnessSyncDirection): boolean {
    return Boolean(direction?.homes && direction.homes.length > 0);
}

function defaultDirection(name: MCPProviderName): HarnessSyncDirection {
    return { homes: [...DEFAULT_HARNESS_HOMES[name]] };
}

/**
 * Fill missing harness sync homes with the built-in defaults.
 * Does not overwrite a harness that already has homes.
 */
export function ensureHarnessDefaults(config: UnifiedMCPConfig): { config: UnifiedMCPConfig; changed: boolean } {
    const harnesses: HarnessSyncMap = { ...config.harnesses };
    let changed = false;

    for (const name of HARNESS_NAMES) {
        const existing = harnesses[name];

        if (!existing) {
            harnesses[name] = {
                syncTo: defaultDirection(name),
                syncFrom: defaultDirection(name),
            };
            changed = true;
            continue;
        }

        const next = { ...existing };

        if (!hasHomes(next.syncTo)) {
            next.syncTo = defaultDirection(name);
            changed = true;
        }

        if (!hasHomes(next.syncFrom)) {
            next.syncFrom = defaultDirection(name);
            changed = true;
        }

        harnesses[name] = next;
    }

    if (!changed) {
        return { config, changed: false };
    }

    return { config: { ...config, harnesses }, changed: true };
}

export function expandHarnessHome(home: string): string {
    const base = env.paths.getHome() || env.paths.getUserProfile() || "";

    if (home === "~") {
        return base;
    }

    if (home.startsWith("~/")) {
        return path.join(base, home.slice(2));
    }

    return home;
}

export function resolveHarnessHomes(
    config: UnifiedMCPConfig,
    name: MCPProviderName,
    direction: "syncTo" | "syncFrom"
): string[] {
    const { config: withDefaults } = ensureHarnessDefaults(config);
    const homes = withDefaults.harnesses?.[name]?.[direction]?.homes ?? DEFAULT_HARNESS_HOMES[name];

    return homes.map(expandHarnessHome);
}

export function codexConfigPathForHome(home: string): string {
    const expanded = expandHarnessHome(home);

    if (expanded.endsWith("config.toml")) {
        return expanded;
    }

    return path.join(expanded, "config.toml");
}

export function codexHomeDir(home: string): string {
    const expanded = expandHarnessHome(home);

    if (expanded.endsWith("config.toml")) {
        return path.dirname(expanded);
    }

    return expanded;
}

export interface CodexHomeServer {
    command?: string;
    url?: string;
    headers?: Record<string, string>;
    http_headers?: Record<string, string>;
    env?: Record<string, string>;
    [key: string]: unknown;
}

export function mergeCodexServersForHome(args: {
    dest: Record<string, CodexHomeServer>;
    incoming: Record<string, CodexHomeServer>;
    destHome: string;
    allHomes: string[];
    protectHomeBound?: boolean;
}): Record<string, CodexHomeServer> {
    const next = { ...args.dest };
    const otherHomes = args.allHomes.filter((home) => home !== args.destHome);
    const protectHomeBound = args.protectHomeBound !== false;

    for (const [name, incoming] of Object.entries(args.incoming)) {
        if (otherHomes.some((home) => serverMentionsPath(incoming, home))) {
            continue;
        }

        const existing = next[name];
        if (existing && isUsableCodexServer(existing) && !isUsableCodexServer(incoming)) {
            continue;
        }

        if (
            protectHomeBound &&
            existing &&
            isUsableCodexServer(existing) &&
            serverMentionsPath(existing, args.destHome)
        ) {
            continue;
        }

        next[name] = incoming;
    }

    return next;
}

function serverMentionsPath(server: CodexHomeServer, homePath: string): boolean {
    return SafeJSON.stringify(server).includes(homePath);
}

function isUsableCodexServer(server: CodexHomeServer): boolean {
    if (typeof server.command === "string" && server.command.length > 0) {
        return true;
    }

    if (typeof server.url === "string" && server.url.length > 0) {
        if (server.headers && !server.http_headers) {
            return false;
        }

        return true;
    }

    return false;
}
