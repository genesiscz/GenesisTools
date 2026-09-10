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

export interface ClientNameSelectOption {
    value: string;
    label: string;
    hint?: string;
}

export const CLIENT_NAME_ABORT = "__abort__";

export interface DcrFailureView {
    title: string;
    detail: string[];
    issue?: string;
    retry: string[];
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

export function clientNameSelectOptions(preset: OauthClientPreset): ClientNameSelectOption[] {
    return [
        ...preset.clientNames.map((choice) => ({
            value: choice.value,
            label: choice.value,
            hint: choice.why,
        })),
        { value: CLIENT_NAME_ABORT, label: "Cancel" },
    ];
}

export function describeDcrFailure(opts: {
    server: string;
    mcpUrl: string;
    status: number;
    body: string;
    clientName: string;
}): DcrFailureView {
    const detail = [`client_name: ${opts.clientName}`];
    const body = opts.body.trim();

    if (body) {
        detail.push(`Server said: ${body}`);
    }

    const view: DcrFailureView = {
        title: `Dynamic client registration failed (HTTP ${opts.status}).`,
        detail,
        retry: [],
    };

    if (opts.status !== 403) {
        return view;
    }

    const preset = oauthClientPresetFor(opts.mcpUrl);

    if (preset) {
        view.issue = preset.issue;
        view.retry = preset.clientNames.map((choice) => suggestedLoginCommand(opts.server, choice.value));

        return view;
    }

    view.issue = "This authorization server refused dynamic client registration.";
    view.retry = [
        suggestCommand("tools mcp-manager", {
            replaceCommand: ["auth", "login", opts.server, "--client-name", "Claude Code"],
        }),
    ];

    return view;
}
