/**
 * What a link to a GenesisTools app says: every preset, its actions, and the plain strings each builds, the router
 * path and the app's own scheme link. No gate and no config: whether such a link opens anything on this Mac is the
 * router's question (`routerLink()` in @genesiscz/utils/browser-router/router-link, which adds the routing facts).
 * The lint rule `no-raw-genesis-link` allows these literals here and in the router only.
 */

/** The hub's query keys, in the order the app reads them (`HubRequest.linkKeys`). */
export const HUB_LINK_KEYS = [
    "mode",
    "session",
    "agent",
    "pr",
    "reveal",
    "repo",
    "commit",
    "tab",
    "filter",
    "worktree",
] as const;

export type HubLinkQuery = Partial<Record<(typeof HUB_LINK_KEYS)[number], string>>;

/** Every preset a link can target, its actions, and the data each action takes. */
export interface LinkTargets {
    "genesis-md": {
        /** A file in Genesis Markdown; `range` highlights lines, `"12"` or `"12-30"`. */
        open: { path: string; range?: string };
    };
    "genesis-hub": {
        /** The GenesisTools hub on a PR, a commit in it, a repository or a session. */
        open: HubLinkQuery;
    };
    "claude-find": {
        /** Scroll to DECISION `decision`; oldest by default, or the requested position. */
        decision: { session: string; decision: number; at?: "oldest" | "newest" };
        /** Scroll it to `q`, the first (`oldest`) or the latest (`newest`, the default) match. */
        text: { session: string; q: string; at?: "oldest" | "newest" };
    };
}

export type LinkPreset = keyof LinkTargets;
export type LinkAction<P extends LinkPreset> = Extract<keyof LinkTargets[P], string>;
export type LinkData<P extends LinkPreset, A extends LinkAction<P>> = LinkTargets[P][A];

export interface AppLink<D> {
    /** The path after the link host. The preset's route turns it into `scheme(data)`. */
    path: (data: D) => string;
    /** Absent when only the router can serve the target: it runs a command, no app opens it. */
    scheme?: (data: D) => string;
}

export type AppLinkTable = { [P in LinkPreset]: { [A in LinkAction<P>]: AppLink<LinkData<P, A>> } };

/** A query, empty values left out. `keepSlash` leaves `/` readable, which a query value may hold. */
function query(pairs: Array<readonly [string, string | undefined]>, { keepSlash }: { keepSlash: boolean }): string {
    const items = pairs.flatMap(([key, value]) => {
        if (value === undefined || value === "") {
            return [];
        }

        const encoded = encodeURIComponent(value);

        return [`${key}=${keepSlash ? encoded.replace(/%2F/g, "/") : encoded}`];
    });

    return items.length > 0 ? `?${items.join("&")}` : "";
}

export const APP_LINKS: AppLinkTable = {
    "genesis-md": {
        open: {
            path: (data) =>
                `md/open${query(
                    [
                        ["path", data.path],
                        ["range", data.range],
                    ],
                    { keepSlash: true }
                )}`,
            scheme: (data) =>
                `genesis-md://open${query(
                    [
                        ["path", data.path],
                        ["range", data.range],
                    ],
                    { keepSlash: true }
                )}`,
        },
    },
    "genesis-hub": {
        open: {
            // `encodeURIComponent` in full: a `+` from URLSearchParams reads back as a literal plus in the app.
            path: (data) =>
                `hub${query(
                    HUB_LINK_KEYS.map((key) => [key, data[key]] as const),
                    { keepSlash: false }
                )}`,
            scheme: (data) =>
                `genesis-tools://hub${query(
                    HUB_LINK_KEYS.map((key) => [key, data[key]] as const),
                    { keepSlash: false }
                )}`,
        },
    },
    "claude-find": {
        decision: {
            path: (data) =>
                `claude/find/${encodeURIComponent(data.session)}/decision/${data.decision}${query([["at", data.at]], { keepSlash: false })}`,
        },
        text: {
            path: (data) =>
                `claude/find/${encodeURIComponent(data.session)}${query(
                    [
                        ["q", data.q],
                        ["at", data.at],
                    ],
                    { keepSlash: false }
                )}`,
        },
    },
};

/** The app's own link for a target, for a caller that opens it rather than prints it (`open genesis-md://…`). */
export function schemeLink<P extends LinkPreset, A extends LinkAction<P>>({
    preset,
    action,
    data,
}: {
    preset: P;
    action: A;
    data: LinkData<P, A>;
}): string {
    const { scheme } = APP_LINKS[preset][action];

    if (!scheme) {
        throw new Error(`${preset} ${action} has no app link; only the router serves it`);
    }

    return scheme(data);
}
