import { agentKindFromLauncher } from "@app/cmux/lib/launchers";
import { mapTerminalSurfaces, profileSurfaces } from "@app/cmux/lib/profile-walk";
import { cleanLaunchCommand } from "@app/cmux/lib/tty-capture";
import type { Profile } from "@app/cmux/lib/types";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";
import { type CoverageTab, type JournalCoverage, journalCoverage } from "@genesiscz/utils/cmux/journal-coverage";

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

/**
 * How many of the profile's terminal tabs the surface journal has a record for: the join every session lookup starts
 * from. A tab saved without a surface UUID cannot be joined and counts as not found.
 */
export function profileJournalJoin(
    profile: Profile,
    options: { beforeMs?: number; refsPath?: string } = {}
): JournalCoverage {
    const tabs: CoverageTab[] = profileSurfaces(profile).flatMap(({ surface, path }) =>
        surface.type === "terminal" ? [{ surfaceId: surface.surface_id ?? `no-surface-id:${path}` }] : []
    );

    return journalCoverage({ tabs, ...options });
}

/** Drop inferred resume commands for agents the user did not ask to restore. */
export function filterReplayByAgents(profile: Profile, agents: AgentKind[]): Profile {
    const allowed = new Set(agents);

    return mapTerminalSurfaces(profile, (surface) => {
        // Filter the prepared command that will actually run; the tab
        // title can still name an agent that ran here previously.
        const command = cleanLaunchCommand(surface.command ?? "").replace(
            /^\S*\/(?=(?:codex|claude|grok|tools)(?:\s|$))/,
            ""
        );
        const kind = agentKindFromLauncher(command);
        const restoresItself = /^tools\s+cmux\s+(?:restore-after-restart|profiles\s+restore)(?:\s|$)/.test(command);
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
    });
}
