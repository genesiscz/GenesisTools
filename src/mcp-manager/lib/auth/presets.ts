import { suggestCommand } from "@genesiscz/utils/cli";

export interface OauthClientChoice {
    value: string;
    why: string;
}

export interface OauthClientPreset {
    id: string;
    issue: string;
    clientNames: OauthClientChoice[];
}

function hostOf(url: string): string | undefined {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}

const FIGMA_HOSTS = new Set(["mcp.figma.com", "api.figma.com", "www.figma.com", "figma.com"]);

const PRESETS: Array<{ hosts: Set<string>; preset: OauthClientPreset }> = [
    {
        hosts: FIGMA_HOSTS,
        preset: {
            id: "figma",
            issue: "Figma dynamic client registration only accepts client_name values that look like Claude Code. A Genesis Tools name is refused with HTTP 403 Forbidden (not JSON).",
            clientNames: [
                { value: "Claude Code", why: "Figma whitelist; measured 200 on DCR" },
                { value: "Claude Code (genesis-tools)", why: "the name that first logged this machine in" },
            ],
        },
    },
];

export function oauthClientPresetFor(url: string | undefined): OauthClientPreset | undefined {
    const host = url ? hostOf(url) : undefined;

    if (!host) {
        return undefined;
    }

    return PRESETS.find((row) => row.hosts.has(host))?.preset;
}

export function suggestedLoginCommand(server: string, clientName: string): string {
    return suggestCommand("tools mcp-manager", {
        replaceCommand: ["auth", "login", server, "--client-name", clientName],
    });
}
