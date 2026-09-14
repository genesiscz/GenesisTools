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

/**
 * Measured 2026-08-31 with plain curl against
 * `POST https://api.figma.com/v1/oauth/mcp/register`, one field changed per arm:
 * dynamic registration is OPEN, and the gate is a PREFIX match on `client_name`.
 * `Genesis Tools` → 403 Forbidden (not JSON); `Claude Code (…)` → 200 with a fresh
 * `client_id`. `Cursor`, `VS Code`, `Xcode`, `Windsurf`, `Zed` and lowercase
 * `claude code` all 403, so this is a literal allowlist of prefixes, not a
 * capability check.
 *
 * 🛑 The bare `"Claude Code"` was OFFERED here until 2026-09-14 and was REMOVED by
 * Martin's decision that day (handoff h_l6hx0tn2 t10). Do not add it back. Both
 * names clear Figma's prefix check, but the bare one is indistinguishable from
 * Anthropic's actual product on Figma's consent screen and in the account's
 * authorised-apps list, while the suffixed one clears the same gate and still names
 * the real client everywhere Figma displays it. Removing it removes the option that
 * misrepresents which software holds the token.
 *
 * This is a retry offered interactively AFTER a 403, never a default and never
 * auto-selected: CLIENT_NAME_DEFAULT stays the honest "Genesis Tools (mcp-manager)",
 * which Figma refuses by design.
 */
const PRESETS: Array<{ hosts: Set<string>; preset: OauthClientPreset }> = [
    {
        hosts: FIGMA_HOSTS,
        preset: {
            id: "figma",
            issue: "Figma dynamic client registration only accepts client_name values that look like Claude Code. A Genesis Tools name is refused with HTTP 403 Forbidden (not JSON).",
            clientNames: [
                {
                    value: "Claude Code (genesis-tools)",
                    why: "clears Figma's prefix check and still names the real client on the consent screen",
                },
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

    view.issue =
        "This authorization server refused dynamic client registration. Some servers restrict which client_name values they accept.";
    // 🛑 Name no vendor here. This branch runs for a server we have NEVER measured, and
    // the Figma prefix gate is a measured quirk of one vendor, not a general rule.
    // Suggesting a Claude-Code-shaped name on this path would turn that one measurement
    // into advice to impersonate another vendor's product at a host where nobody has
    // evidence it helps — the cargo-cult version of a carefully measured finding.
    //
    // A second server that turns out to gate the same way earns its OWN preset with its
    // own measurement, exactly as Figma has one. That keeps the seam honest: presets are
    // data justified by a measurement, never a guess.
    view.retry = [
        suggestCommand("tools mcp-manager", {
            replaceCommand: ["auth", "login", opts.server, "--client-name", "<name>"],
        }),
    ];

    return view;
}
