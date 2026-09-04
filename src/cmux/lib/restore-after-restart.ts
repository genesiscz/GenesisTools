import { inferLauncherFromTitle } from "@app/cmux/lib/agent-replay";
import { agentKindFromLauncher, isAgentLauncher } from "@app/cmux/lib/command-capture";
import type { Profile, TerminalSurface } from "@app/cmux/lib/types";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";

export type RestoreRestartSource = "previous" | "live" | "profile";

export const ALL_RESTORE_AGENTS: AgentKind[] = ["claude", "grok", "codex"];

/** Commander sets a bare `--flag` to `true` when the option is `--flag [value]`. */
export function isMissingEnumFlag(raw: unknown): boolean {
    return raw === true || raw === "";
}

export function parseRestoreSource(raw: string | undefined): RestoreRestartSource | undefined {
    if (raw === "previous" || raw === "live" || raw === "profile") {
        return raw;
    }

    return undefined;
}

export function parseAgentList(raw: string | undefined): AgentKind[] {
    if (!raw?.trim()) {
        return [...ALL_RESTORE_AGENTS];
    }

    const kinds: AgentKind[] = [];
    for (const part of raw.split(",")) {
        const trimmed = part.trim().toLowerCase();
        if (!trimmed) {
            continue;
        }

        if (trimmed !== "claude" && trimmed !== "grok" && trimmed !== "codex") {
            throw new Error(`--agents must be a comma list of claude, grok, codex (got "${raw}")`);
        }

        if (!kinds.includes(trimmed)) {
            kinds.push(trimmed);
        }
    }

    if (kinds.length === 0) {
        throw new Error(`--agents must be a comma list of claude, grok, codex (got "${raw}")`);
    }

    return kinds;
}

function surfaceKind(surface: TerminalSurface): AgentKind | undefined {
    return (
        inferLauncherFromTitle(surface.title) ?? (surface.command ? agentKindFromLauncher(surface.command) : undefined)
    );
}

/** Drop inferred resume commands for agents the user did not ask to restore. */
export function filterReplayByAgents(profile: Profile, agents: AgentKind[]): Profile {
    const allowed = new Set(agents);

    return {
        ...profile,
        windows: profile.windows.map((window) => ({
            ...window,
            workspaces: window.workspaces.map((workspace) => ({
                ...workspace,
                panes: workspace.panes.map((pane) => ({
                    ...pane,
                    surfaces: pane.surfaces.map((surface) => {
                        if (surface.type !== "terminal") {
                            return surface;
                        }

                        const kind = surfaceKind(surface);
                        if (!kind || allowed.has(kind)) {
                            return surface;
                        }

                        if (surface.command && isAgentLauncher(surface.command)) {
                            return { ...surface, command: undefined, command_source: undefined };
                        }

                        return surface;
                    }),
                })),
            })),
        })),
    };
}
