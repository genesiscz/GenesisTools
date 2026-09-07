import { agentKindFromLauncher, cleanLaunchCommand } from "@app/cmux/lib/command-capture";
import type { Profile } from "@app/cmux/lib/types";
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

                        // Filter the prepared command that will actually run; the tab
                        // title can still name an agent that ran here previously.
                        const command = cleanLaunchCommand(surface.command ?? "").replace(
                            /^\S*\/(?=(?:codex|claude|grok|tools)(?:\s|$))/,
                            ""
                        );
                        const kind = agentKindFromLauncher(command);
                        const restoresItself =
                            /^tools\s+cmux\s+(?:restore-after-restart|profiles\s+restore)(?:\s|$)/.test(command);
                        if (restoresItself || (kind && !allowed.has(kind))) {
                            return {
                                ...surface,
                                command: undefined,
                                command_source: undefined,
                                command_original: surface.command,
                                drift: [
                                    restoresItself
                                        ? "skipped restore command to avoid recursive restoration"
                                        : `skipped ${kind}: agent not selected`,
                                ],
                            };
                        }

                        return surface;
                    }),
                })),
            })),
        })),
    };
}
