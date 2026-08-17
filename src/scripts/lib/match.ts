/**
 * Selector grammar for tool refs.
 *
 * A selector is `[provider:]<server>.<tool>`, where either half of the
 * server.tool pair may contain `*`. A selector with no dot is a server
 * selector (all its tools).
 *
 *   chrome-devtools-mcp.*        every tool on that server
 *   chrome-devtools-mcp          same thing, shorthand
 *   *.take_screenshot            that tool wherever it exists
 *   genesis-tools.handoff_*      prefix match on the tool name
 *   mcp:genesis-tools.handoff_*  same, provider spelled out
 *   *.*                          everything (probes every server; slow first time)
 *
 * The provider prefix is reserved grammar for future binding surfaces
 * (openapi:, composio:, graphql:, gt:). A bare selector means `mcp:` — that
 * default is permanent, so today's short form never breaks. v1 implements only
 * the mcp provider; any other prefix is an error naming the known set.
 *
 * Server names routinely contain `-`, and `.` is only ever the separator we
 * add. Selectors are matched against the known server list first, so a server
 * whose name itself contains a dot still parses correctly.
 */

export const KNOWN_PROVIDERS = ["mcp"] as const;
export type ProviderName = (typeof KNOWN_PROVIDERS)[number];

export interface Selector {
    raw: string;
    provider: ProviderName;
    server: string;
    tool: string;
}

function toRegExp(pattern: string): RegExp {
    // The wildcard placeholder must be a character that cannot occur in the
    // pattern itself, or a literal occurrence would also expand to `.*`.
    const WILDCARD = "\u0000";
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? WILDCARD : `\\${ch}`));
    return new RegExp(`^${escaped.split(WILDCARD).join(".*")}$`, "i");
}

export function globMatch(pattern: string, value: string): boolean {
    if (!pattern.includes("*")) {
        return pattern.toLowerCase() === value.toLowerCase();
    }

    return toRegExp(pattern).test(value);
}

/**
 * Strip and validate the optional provider prefix.
 *
 * Only a prefix that looks like an identifier counts, and a prefix followed by
 * `//` is a URL scheme (`http://x`), not a provider. Known server names get
 * matched against the server list BEFORE this runs, so a server whose name
 * contains a colon never reaches provider parsing.
 */
function splitProvider(raw: string): { provider: ProviderName; rest: string } {
    const colon = raw.indexOf(":");

    if (colon <= 0) {
        return { provider: "mcp", rest: raw };
    }

    const prefix = raw.slice(0, colon);

    if (!/^[a-z][a-z0-9_-]*$/i.test(prefix) || raw.startsWith("//", colon + 1)) {
        return { provider: "mcp", rest: raw };
    }

    if (!(KNOWN_PROVIDERS as readonly string[]).includes(prefix.toLowerCase())) {
        throw new Error(
            `Unknown provider '${prefix}' in selector '${raw}'. Known providers: ${KNOWN_PROVIDERS.join(", ")}. ` +
                "A bare selector means mcp:."
        );
    }

    return { provider: prefix.toLowerCase() as ProviderName, rest: raw.slice(colon + 1) };
}

/** Longest known server name the value starts with, or undefined. */
function matchKnownServer(value: string, knownServers: string[]): string | undefined {
    return knownServers.filter((s) => value === s || value.startsWith(`${s}.`)).sort((a, b) => b.length - a.length)[0];
}

/**
 * Split a selector into provider, server and tool.
 *
 * `knownServers` disambiguates the server/tool split: the longest known server
 * name the selector starts with wins, so a server called `a.b` (or one with a
 * colon in its name) still parses. Falls back to splitting on the first dot.
 */
export function parseSelector(raw: string, knownServers: string[] = []): Selector {
    const trimmed = raw.trim();

    if (!trimmed) {
        throw new Error("Empty selector");
    }

    // Server-list match runs before provider parsing, so a server name that
    // happens to contain a colon is never mistaken for a provider prefix.
    const direct = matchKnownServer(trimmed, knownServers);

    if (direct) {
        const tool = trimmed === direct ? "*" : trimmed.slice(direct.length + 1);
        return { raw: trimmed, provider: "mcp", server: direct, tool: tool || "*" };
    }

    const { provider, rest } = splitProvider(trimmed);

    if (!rest) {
        throw new Error(`Selector '${raw}' names a provider but nothing else`);
    }

    const server = matchKnownServer(rest, knownServers);

    if (server) {
        const tool = rest === server ? "*" : rest.slice(server.length + 1);
        return { raw: trimmed, provider, server, tool: tool || "*" };
    }

    const dot = rest.indexOf(".");

    if (dot === -1) {
        return { raw: trimmed, provider, server: rest, tool: "*" };
    }

    return { raw: trimmed, provider, server: rest.slice(0, dot), tool: rest.slice(dot + 1) || "*" };
}

export function matchesSelector(selector: Selector, server: string, tool: string): boolean {
    return globMatch(selector.server, server) && globMatch(selector.tool, tool);
}
