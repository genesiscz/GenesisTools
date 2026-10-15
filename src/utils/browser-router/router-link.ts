import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type LinkGate, linkGate } from "./link-gate";

/**
 * The one door for a link to a GenesisTools app. A link that opens nothing is worse than none, and
 * whether it opens depends on this Mac (is the router installed, is it the https handler, is the preset
 * on), so a caller names WHAT to open and gets the link only when it works, or its fallback with the
 * reason. The lint rule `no-raw-genesis-link` refuses a hand-written one anywhere else.
 *
 * ```ts
 * const { result } = routerLink({
 *     preset: "genesis-md",
 *     action: "open",
 *     data: { path },
 *     fallback: () => path,
 * });
 * ```
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
        /** Scroll a live Claude session's transcript to where DECISION `decision` was first asked. */
        decision: { session: string; decision: number };
        /** Scroll it to `q`, the first (`oldest`) or the latest (`newest`, the default) match. */
        text: { session: string; q: string; at?: "oldest" | "newest" };
    };
}

export type LinkPreset = keyof LinkTargets;
export type LinkAction<P extends LinkPreset> = Extract<keyof LinkTargets[P], string>;
export type LinkData<P extends LinkPreset, A extends LinkAction<P>> = LinkTargets[P][A];

/** `router`: an https link on the link host, clickable everywhere. `scheme`: the app's own link, no router needed. */
export type LinkVia = "router" | "scheme";

interface Target<D> {
    /** The path after the link host. The preset's route turns it into `scheme(data)`. */
    path: (data: D) => string;
    /** Absent when only the router can serve the target: it runs a command, no app opens it. */
    scheme?: (data: D) => string;
    /** Whether the app behind `scheme` is on this Mac. */
    appInstalled?: (gate: LinkGate) => boolean;
    /** Transports when the caller does not pass `via`. Default is the router. */
    transports?: readonly LinkVia[];
}

/**
 * The markdown app can be installed while its router preset is off, because that preset also
 * needs a link host. A missing app capability starts with `app:`; a missing host does not.
 */
function markdownInstalled(gate: LinkGate): boolean {
    const row = gate.presets["genesis-md"];

    if (!row) {
        return false;
    }

    if (row.available) {
        return true;
    }

    return row.missing.every((item) => !item.startsWith("app:"));
}

type TargetTable = { [P in LinkPreset]: { [A in LinkAction<P>]: Target<LinkData<P, A>> } };

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

const TARGETS: TargetTable = {
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
            appInstalled: markdownInstalled,
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
            appInstalled: (gate) => gate.installed,
            // The router where the `genesis-hub` preset routes `/hub`, since every terminal makes an
            // https link clickable; else the app scheme. A version without that preset falls through.
            transports: ["router", "scheme"],
        },
    },
    "claude-find": {
        decision: {
            path: (data) => `claude/find/${encodeURIComponent(data.session)}/decision/${data.decision}`,
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
    const { scheme } = TARGETS[preset][action];

    if (!scheme) {
        throw new Error(`${preset} ${action} has no app link; only the router serves it`);
    }

    return scheme(data);
}

export type LinkErrorCode =
    | "router-missing"
    | "not-https-handler"
    | "no-link-host"
    | "preset-off"
    | "app-missing"
    | "declined";

export interface LinkError {
    code: LinkErrorCode;
    message: string;
    reason: string;
}

export interface LinkContext {
    gate: LinkGate;
    /** Whether a router link for `preset` opens on this Mac. */
    presetRouted: (preset: LinkPreset) => boolean;
}

export interface LinkResult<R> {
    result: R;
    /** The link that `render` got, or null when the fallback ran. */
    link: string | null;
    via: LinkVia | null;
    /** Why the fallback ran: the first transport's reason. */
    error?: LinkError;
}

interface LinkOptions<P extends LinkPreset, A extends LinkAction<P>> {
    preset: P;
    action: A;
    data: LinkData<P, A>;
    /** Transports to try, in order. Omitted: the target's own list, or `["router"]`. */
    via?: readonly LinkVia[];
    /** A further condition; `false` gives the fallback with code `declined`. */
    when?: (ctx: LinkContext) => boolean;
    /** The router facts to judge by; read from the cached gate when omitted. */
    gate?: LinkGate;
}

/** What to print with a link that works. Not `then`: an object with a `then` method is a thenable, and `await` would call it. */
type Render<R> = (ctx: LinkContext & { link: string; via: LinkVia }) => R;
type Fallback<R> = (ctx: LinkContext & { error: LinkError }) => R;

/** Why a router link for `preset` would open nothing, or null when it opens. */
export function routerError(gate: LinkGate, preset: string): LinkError | null {
    if (!gate.installed) {
        return {
            code: "router-missing",
            message: "GenesisTools.app is not installed, so nothing routes the link",
            reason: "browser-router:installed is false",
        };
    }

    if (!gate.defaultHandler) {
        return {
            code: "not-https-handler",
            message: "macOS opens https links with another app, so a click never reaches the router",
            reason: `the https handler is ${gate.httpsHandler ?? "unset"}`,
        };
    }

    if (!gate.linkHost) {
        return {
            code: "no-link-host",
            message: "the router has no link host to build the link on",
            reason: gate.configured ? "the config has no linkHost" : "there is no browser-router config",
        };
    }

    const row = gate.presets[preset];

    if (!row?.enabled || !row.routed) {
        const why = !row
            ? "this GenesisTools version has no such preset"
            : !row.available
              ? `it needs ${row.missing.join(", ")}`
              : !row.enabled
                ? "it is off in the config"
                : "the config does not hold its routes";

        return {
            code: "preset-off",
            message: `the router does not route ${preset} on this Mac`,
            reason: `${why} (${toolCommand("browser-router presets")})`,
        };
    }

    return null;
}

function linkFor<P extends LinkPreset, A extends LinkAction<P>>({
    options,
    gate,
    via,
}: {
    options: LinkOptions<P, A>;
    gate: LinkGate;
    via: LinkVia;
}): { link: string } | { error: LinkError } {
    const target = TARGETS[options.preset][options.action];

    if (via === "scheme") {
        if (!target.scheme) {
            return {
                error: {
                    code: "app-missing",
                    message: `no app opens ${options.preset} links; only the router serves them`,
                    reason: "the target has no app scheme",
                },
            };
        }

        return target.appInstalled?.(gate)
            ? { link: target.scheme(options.data) }
            : {
                  error: {
                      code: "app-missing",
                      message: `the app that opens ${options.preset} links is not installed`,
                      reason: `no app for ${target.scheme(options.data).split(":")[0]}://`,
                  },
              };
    }

    const error = routerError(gate, options.preset);

    return error ? { error } : { link: `https://${gate.linkHost}/${target.path(options.data)}` };
}

export function routerLink<P extends LinkPreset, A extends LinkAction<P>, R>(
    options: LinkOptions<P, A> & { render: Render<R>; fallback: Fallback<R> }
): LinkResult<R>;
export function routerLink<P extends LinkPreset, A extends LinkAction<P>>(
    options: LinkOptions<P, A> & { fallback: Fallback<string> }
): LinkResult<string>;
export function routerLink<P extends LinkPreset, A extends LinkAction<P>, R>(
    options: LinkOptions<P, A> & { render?: Render<R>; fallback: Fallback<R | string> }
): LinkResult<R | string> {
    const gate = options.gate ?? linkGate();
    const ctx: LinkContext = { gate, presetRouted: (preset) => routerError(gate, preset) === null };

    if (options.when && !options.when(ctx)) {
        const error: LinkError = {
            code: "declined",
            message: "the caller's condition said no",
            reason: "when() returned false",
        };
        return { result: options.fallback({ ...ctx, error }), link: null, via: null, error };
    }

    const transports = options.via ?? TARGETS[options.preset][options.action].transports ?? ["router"];
    let first: LinkError | undefined;

    for (const via of transports) {
        const found = linkFor({ options, gate, via });

        if ("link" in found) {
            const result = options.render ? options.render({ ...ctx, link: found.link, via }) : found.link;
            return { result, link: found.link, via };
        }

        first ??= found.error;
    }

    const error: LinkError = first ?? {
        code: "declined",
        message: "no transport was asked for",
        reason: "via is empty",
    };

    return { result: options.fallback({ ...ctx, error }), link: null, via: null, error };
}
