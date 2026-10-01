import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { type Capability, type CapabilityCheck, hasCapability } from "./capabilities";
import { compileRoutePattern, linkPattern, type PresetOptions, type RouteRule, type RouterConfig } from "./route";
import { dashboardNameRoutes, localServiceRoutes } from "./services";

export type { Capability, CapabilityCheck } from "./capabilities";

const markdownApp = "/Applications/Genesis.app/Contents/Helpers/Genesis Markdown.app";
const toolsBin = join(import.meta.dir, "..", "..", "..", "tools");

/** The link `handoff_post` mints, query and all: a route anchored at `/run$` must not count. */
export function cmuxLaunchUrl(linkHost: string): string {
    return `https://${linkHost}/cmux/claude/run`;
}

/** `decide/<session>/<n>/<letter>`: nothing else matches, so a link cannot carry free text. */
export function decidePattern(linkHost: string): string {
    return linkPattern(linkHost, "decide/([A-Za-z0-9_-]{1,64})/(\\d{1,6})/([a-z])");
}

/** The `core` preset's patterns on a link host: minted links, wrapped local links, tab bundles. */
export function corePatterns(linkHost: string): { token: string; unwrap: string; tabs: string } {
    return {
        token: linkPattern(linkHost, "t/([A-Za-z0-9_-]+)"),
        unwrap: linkPattern(linkHost, "link/(.+)"),
        tabs: linkPattern(linkHost, "tabs/([A-Za-z0-9_-]+)"),
    };
}

/**
 * `default` presets are on whenever they can be (today only `core`, the link machinery itself).
 * `installable` presets are off until `tools browser-router presets enable <id>`.
 */
export type PresetKind = "default" | "installable";

export interface PresetSpec {
    id: string;
    title: string;
    kind: PresetKind;
    /** One line for `presets`: what a click does once this is on. */
    description: string;
    /** Every capability must hold before the preset can be on. */
    enabledIf: Capability[];
    /** The routes are paths on the link host, so the preset needs one. */
    needsLinkHost?: boolean;
    /** Option names `presets enable` accepts, such as `only`. */
    options?: (keyof PresetOptions)[];
    /** A link this preset serves. `presetRouted` checks that the saved config really sends it here. */
    probe?: string;
    routes: RouteRule[];
}

export interface Preset extends PresetSpec {
    /** Every capability holds, and the link host is set when the preset needs one. */
    available: boolean;
    /** Available and on: a default preset always, an installable one when `config.presets` names it. */
    enabled: boolean;
    /** What keeps it from being available, in words, for `presets` and `enable`. */
    missing: string[];
}

interface CatalogContext {
    linkHost?: string;
    options: Record<string, PresetOptions>;
}

function catalog({ linkHost, options }: CatalogContext): PresetSpec[] {
    const on = (host: string, path: string) => linkPattern(host, path);
    const withHost = (build: (host: string) => RouteRule[]): RouteRule[] => (linkHost ? build(linkHost) : []);

    return [
        {
            id: "core",
            title: "Router links",
            kind: "default",
            description: "Minted one-use links (/t/), tab bundles (/tabs/) and wrapped local links (/link/).",
            enabledIf: [],
            needsLinkHost: true,
            routes: withHost((host) => [
                { preset: "core", pattern: corePatterns(host).token, action: { type: "token" } },
                { preset: "core", pattern: corePatterns(host).unwrap, action: { type: "unwrap" } },
                {
                    preset: "core",
                    pattern: corePatterns(host).tabs,
                    name: "Open tabs",
                    action: { type: "run", argv: ["tools", "browser-router", "tabs", "open", "$1"], approval: "allow" },
                },
            ]),
        },
        {
            id: "local-services",
            title: "Local servers start themselves",
            kind: "installable",
            description: "A click on localhost:<port> of a registered server starts it before the page opens.",
            enabledIf: [],
            options: ["only"],
            routes: localServiceRoutes(options["local-services"]?.only),
        },
        {
            id: "genesis-md",
            title: "Genesis Markdown",
            kind: "installable",
            description: "https://<link host>/md/<path> opens genesis-md://<path> in Genesis Markdown.",
            enabledIf: [`file:${markdownApp}`],
            needsLinkHost: true,
            routes: withHost((host) => [
                { preset: "genesis-md", pattern: on(host, "md/(.*)"), action: { type: "open", to: "genesis-md://$1" } },
            ]),
        },
        {
            id: "mail",
            title: "Mail",
            kind: "installable",
            description: "https://<link host>/mail/show/<rowid> opens that message in Mail (tools macos mail open).",
            enabledIf: ["platform:darwin"],
            needsLinkHost: true,
            routes: withHost((host) => [
                {
                    preset: "mail",
                    name: "Open mail",
                    pattern: on(host, "mail/show/(\\d+)"),
                    action: {
                        type: "run",
                        argv: ["tools", "macos", "mail", "open", "$1"],
                        approval: "allow",
                        notify: "Opened mail $1",
                    },
                },
            ]),
        },
        {
            id: "decide",
            title: "Claude decision answer",
            kind: "installable",
            // Types an answer into a live session with approval allow. The URL carries only a
            // session id, a number and one letter.
            description:
                "https://<link host>/decide/<session>/<n>/<letter> types that answer into a live Claude session.",
            enabledIf: ["claude:installed"],
            needsLinkHost: true,
            probe: linkHost ? `https://${linkHost}/decide/00000000-0000-4000-8000-000000000000/1/a` : undefined,
            routes: withHost((host) => [
                {
                    preset: "decide",
                    name: "Answer a decision",
                    pattern: decidePattern(host),
                    action: {
                        type: "run",
                        // `?q=<form id>` also closes a pending `tools question` form; decide validates it.
                        argv: [
                            "tools",
                            "claude",
                            "decide",
                            "--session",
                            "$1",
                            "--decision",
                            "$2",
                            "--option",
                            "$3",
                            "--question",
                            "{q}",
                        ],
                        approval: "allow",
                        notify: "Answered DECISION $2: $3)",
                    },
                },
            ]),
        },
        {
            id: "cmux-claude",
            title: "Claude in cmux",
            kind: "installable",
            description:
                "https://<link host>/cmux/claude/run?prompt=... starts Claude in a new cmux surface, after a prompt.",
            enabledIf: ["cmux:installed", "browser-router:installed"],
            needsLinkHost: true,
            probe: linkHost
                ? `${cmuxLaunchUrl(linkHost)}?name=handoff%20probe&prompt=probe&surface=new&cwd=%2Ftmp`
                : undefined,
            routes: withHost((host) => [
                {
                    preset: "cmux-claude",
                    name: "Run Claude in cmux",
                    pattern: on(host, "cmux/claude/run"),
                    action: {
                        type: "run",
                        argv: [
                            "tools",
                            "cmux",
                            "launch",
                            "--open",
                            "--agent",
                            "{agent}",
                            "--account",
                            "{account}",
                            "--surface",
                            "{surface}",
                            "--cwd",
                            "{cwd}",
                            "--resume",
                            "{resume}",
                            "--name",
                            "{name}",
                            "--model",
                            "{model}",
                            "--prompt",
                            "{prompt}",
                        ],
                        approval: "ask",
                        trustMinted: true,
                        notify: "Claude in cmux",
                    },
                },
            ]),
        },
        {
            id: "artifact",
            title: "Artifacts",
            kind: "installable",
            description: "https://<link host>/artifact/<name>/<page> opens a registered artifact page.",
            enabledIf: [`file:${toolsBin}`],
            needsLinkHost: true,
            routes: withHost((host) => [
                {
                    preset: "artifact",
                    name: "Open artifact",
                    // /artifact/<registered name>/<page>; the name charset keeps a link from smuggling flags.
                    pattern: on(host, "artifact/([A-Za-z0-9][A-Za-z0-9._-]*)/?([^?#]*)(?:[?#].*)?"),
                    action: {
                        type: "run",
                        // `--` keeps a page that starts with a hyphen from being read as a flag.
                        argv: [toolsBin, "artifact", "open", "--", "$1", "$2"],
                        approval: "allow",
                        notify: "Opened artifact $1",
                    },
                },
            ]),
        },
        // Last: its /<key>/ paths on the link host must not shadow a specific preset (/artifact/<name>/...).
        {
            id: "dashboard-names",
            title: "Dashboard names",
            kind: "installable",
            description: "https://<name> and https://<link host>/<name> open that registered dashboard, started first.",
            enabledIf: [],
            options: ["only", "names"],
            routes: dashboardNameRoutes({
                linkHost,
                only: options["dashboard-names"]?.only,
                names: options["dashboard-names"]?.names,
            }),
        },
    ];
}

const LINK_HOST_MISSING = "a link host (tools browser-router link-host <host>)";

/** The catalog for this config: routes built on its link host, availability from this Mac. */
export function presets({
    config,
    check = hasCapability,
}: {
    config: RouterConfig | null;
    check?: CapabilityCheck;
}): Preset[] {
    const chosen = config?.presets ?? {};
    const specs = catalog({ linkHost: config?.linkHost, options: chosen });

    return specs.map((spec) => {
        const missing: string[] = spec.enabledIf.filter((capability) => !check(capability));

        if (spec.needsLinkHost && !config?.linkHost) {
            missing.push(LINK_HOST_MISSING);
        }

        const available = missing.length === 0;
        const enabled = available && (spec.kind === "default" || chosen[spec.id] !== undefined);
        return { ...spec, available, enabled, missing };
    });
}

export function presetById(id: string, catalogue: Preset[]): Preset | undefined {
    return catalogue.find((preset) => preset.id === id);
}

/**
 * Whether the saved config sends this preset's links to this preset. With a probe, the FIRST route
 * that matches the probe decides (the router takes the first match): it must carry the preset tag or
 * run the same command. Without a probe, a route tagged with the preset id is enough.
 */
export function presetRouted(config: RouterConfig, preset: PresetSpec): boolean {
    if (!preset.probe) {
        return config.routes.some((rule) => rule.preset === preset.id);
    }

    const probe = preset.probe;
    const first = config.routes.find((rule) => {
        try {
            return compileRoutePattern(rule.pattern).test(probe);
        } catch (error) {
            logger.debug({ error, pattern: rule.pattern }, "browser-router: a saved pattern does not compile");
            return false;
        }
    });

    if (!first) {
        return false;
    }

    if (first.preset === preset.id) {
        return true;
    }

    const own = preset.routes[0]?.action;

    if (first.action.type !== "run" || own?.type !== "run") {
        return false;
    }

    return first.action.argv.slice(0, 3).join(" ") === own.argv.slice(0, 3).join(" ");
}

/**
 * How the saved routes this preset owns differ from what it ships: one line per route that is missing
 * or whose action changed (a hand edit, or a config not rewritten since the preset changed), and one
 * per saved route whose pattern the preset no longer ships. Empty when the preset has no saved route.
 */
export function presetDrift(config: RouterConfig, preset: PresetSpec): string[] {
    const saved = config.routes.filter((rule) => rule.preset === preset.id);

    if (saved.length === 0) {
        return [];
    }

    const drift: string[] = [];

    for (const route of preset.routes) {
        const label = route.name ?? route.pattern;
        const match = saved.find((rule) => rule.pattern === route.pattern);

        if (!match) {
            drift.push(`${label}: route missing`);
        } else if (!Bun.deepEquals(match.action, route.action)) {
            drift.push(`${label}: action differs from the preset`);
        }
    }

    const shipped = new Set(preset.routes.map((route) => route.pattern));

    for (const rule of saved) {
        if (!shipped.has(rule.pattern)) {
            drift.push(`${rule.pattern}: no longer in the preset`);
        }
    }

    return drift;
}

/**
 * The routes a config should hold: every enabled default preset first, then the user's own routes
 * (untagged, in their saved order), then every enabled installable preset. A user route with the
 * same pattern as a preset route replaces it.
 */
export function applyPresets(routes: RouteRule[], catalogue: Preset[]): RouteRule[] {
    const own = routes.filter((route) => route.preset === undefined).map((route) => ({ ...route }));
    const taken = new Set(own.map((route) => route.pattern));
    const fromPresets = (kind: PresetKind) =>
        catalogue
            .filter((preset) => preset.kind === kind && preset.enabled)
            .flatMap((preset) => preset.routes)
            .filter((route) => !taken.has(route.pattern))
            .map((route) => ({ ...route }));

    return [...fromPresets("default"), ...own, ...fromPresets("installable")];
}
