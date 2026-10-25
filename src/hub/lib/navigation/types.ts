/**
 * The hub's navigation history: every place the hub showed, who took it there and why. The log lives here, in
 * the `nav_entries` table of `~/.genesis-tools/hub/data.db` (`openHubDb`); GenesisTools.app reads and writes it through `tools hub nav`, and its
 * GenesisKit engine (`NavigationHistory`) walks it with Back, Forward and a hop.
 */

/** Who moved the hub: a click in the hub, an agent (`tools hub nav open`), or a link that named nobody. */
export const NAV_ACTORS = ["user", "agent", "link"] as const;
export type NavActor = (typeof NAV_ACTORS)[number];

/**
 * A place, as the hub's link query names it (`HUB_LINK_KEYS`, read by `HubRequest` in the app). `selection` is the
 * hub's own: the row its mode had selected (a session row id, a worktree path, a PR's id), which the hub restores
 * exactly; a place an agent named has the link keys only.
 */
export const NAV_TARGET_KEYS = [
    "mode",
    "session",
    "agent",
    "pr",
    "reveal",
    "repo",
    "commit",
    "tab",
    "worktree",
    "selection",
] as const;
export type NavTargetKey = (typeof NAV_TARGET_KEYS)[number];
export type NavTarget = Partial<Record<NavTargetKey, string>>;

export interface NavEntry {
    id: string;
    /** Milliseconds since the epoch. */
    at: number;
    actor: NavActor;
    title: string;
    target: NavTarget;
    note?: string;
    /** The agent session that asked for it. */
    from?: string;
}

export const NAV_DEFAULT_KEEP = 200;

export function isNavActor(value: unknown): value is NavActor {
    return typeof value === "string" && (NAV_ACTORS as readonly string[]).includes(value);
}

function isNavTargetKey(value: string): value is NavTargetKey {
    return (NAV_TARGET_KEYS as readonly string[]).includes(value);
}

/** The known keys of `raw` with a non-empty string value; anything else is dropped. */
export function normalizeTarget(raw: unknown): NavTarget {
    const target: NavTarget = {};

    if (typeof raw !== "object" || raw === null) {
        return target;
    }

    for (const [key, value] of Object.entries(raw)) {
        if (isNavTargetKey(key) && typeof value === "string" && value.trim() !== "") {
            target[key] = value.trim();
        }
    }

    return target;
}
