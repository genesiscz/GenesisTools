import { genesisMdLink } from "./open-file";
import { linkQuery } from "./query";

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
    // The Inbox at one card: a decision or todo (`d_3_<session>`) or a pending form (`ask_…`).
    "decision",
    "question",
    // The Usage mode's place (`tools hub open --usage-…`): a section, a session's analysis and its harness, the
    // accounts to select (`usage-account` repeats), or every account (`usage-all-accounts=1`, a bare flag in the app).
    "usage-section",
    "usage-session",
    "usage-harness",
    "usage-account",
    "usage-all-accounts",
    // Who asked for the place, for the hub's navigation history (`tools hub nav open`): `actor` is user, agent or
    // link (a link without it counts as link), `note` says why, `from` is the agent's session id, `nav` the id the
    // CLI already stored the entry under, so the hub updates that entry instead of adding a second one.
    "actor",
    "note",
    "from",
    "nav",
] as const;

export type HubLinkKey = (typeof HUB_LINK_KEYS)[number];
/** One value per key, except `usage-account`, which a link repeats: each value is one `--usage-account`. */
export type HubLinkQuery = Partial<Record<Exclude<HubLinkKey, "usage-account">, string>> & {
    "usage-account"?: readonly string[];
};

/** The query pairs of a hub link in `HUB_LINK_KEYS` order, a repeated key once per value. */
function hubLinkPairs(data: HubLinkQuery): Array<readonly [string, string | undefined]> {
    return HUB_LINK_KEYS.flatMap((key) => {
        const value = data[key];
        if (value === undefined || typeof value === "string") {
            return [[key, value] as const];
        }

        return value.map((item) => [key, item] as const);
    });
}

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
    finder: {
        /** Show a file or a folder in Finder. Only the router serves it: no app scheme opens Finder. */
        reveal: { target: string };
    };
    "meetings-play": {
        /** Play a meeting's audio from a transcript time (`tools meetings play`). Only the router serves it. */
        play: { meeting: string; at: string };
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

export const APP_LINKS: AppLinkTable = {
    "genesis-md": {
        open: {
            path: (data) =>
                `md/open${linkQuery(
                    [
                        ["path", data.path],
                        ["range", data.range],
                    ],
                    { keepSlash: true }
                )}`,
            scheme: (data) => genesisMdLink(data),
        },
    },
    "genesis-hub": {
        open: {
            // `encodeURIComponent` in full: a `+` from URLSearchParams reads back as a literal plus in the app.
            path: (data) => `hub${linkQuery(hubLinkPairs(data), { keepSlash: false })}`,
            scheme: (data) => `genesis-tools://hub${linkQuery(hubLinkPairs(data), { keepSlash: false })}`,
        },
    },
    finder: {
        reveal: {
            path: (data) => `finder/reveal${linkQuery([["target", data.target]], { keepSlash: true })}`,
        },
    },
    "meetings-play": {
        play: {
            path: (data) =>
                `meetings/play${linkQuery(
                    [
                        ["meeting", data.meeting],
                        ["at", data.at],
                    ],
                    { keepSlash: false }
                )}`,
        },
    },
    "claude-find": {
        decision: {
            path: (data) =>
                `claude/find/${encodeURIComponent(data.session)}/decision/${data.decision}${linkQuery([["at", data.at]], { keepSlash: false })}`,
        },
        text: {
            path: (data) =>
                `claude/find/${encodeURIComponent(data.session)}${linkQuery(
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
