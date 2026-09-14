import path from "node:path";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import type { HarnessSyncDirection, HarnessSyncMap, MCPProviderName } from "@app/mcp-manager/utils/types.js";
import { env } from "@genesiscz/utils/env";

export const DEFAULT_HARNESS_HOMES: Record<MCPProviderName, string[]> = {
    claude: ["~/.claude.json"],
    gemini: ["~/.gemini/settings.json"],
    cursor: ["~/.cursor/mcp.json"],
    codex: ["~/.codex"],
    grok: ["~/.grok"],
};

const HARNESS_NAMES: MCPProviderName[] = ["claude", "gemini", "cursor", "codex", "grok"];

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

/** End of value, a path separator, or the quote/space that closes the path inside a larger argument. */
const PATH_BOUNDARY = new Set(["/", "\\", '"', "'", " ", "\t", ":", ",", ";"]);

function* stringValues(value: unknown): Generator<string> {
    if (typeof value === "string") {
        yield value;
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            yield* stringValues(item);
        }

        return;
    }

    if (value && typeof value === "object") {
        for (const item of Object.values(value)) {
            yield* stringValues(item);
        }
    }
}

/**
 * Codex homes are prefixes of each other by design (`~/.codex`, `~/.codex-shop`),
 * so a substring test binds a shop-home server to the primary home and drops it
 * from both. The home only counts when it ends at a real path boundary.
 */
function serverMentionsPath(server: CodexHomeServer, homePath: string): boolean {
    const home = homePath.replace(/[/\\]+$/, "");

    if (!home) {
        return false;
    }

    for (const value of stringValues(server)) {
        for (let at = value.indexOf(home); at !== -1; at = value.indexOf(home, at + 1)) {
            const next = value[at + home.length];

            if (next === undefined || PATH_BOUNDARY.has(next)) {
                return true;
            }
        }
    }

    return false;
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
