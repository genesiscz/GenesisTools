import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { type Capability, type CapabilityCheck, hasCapability } from "./capabilities";
import { compileRoutePattern, LEGACY_LOCAL_CATCH_ALL, type RouteRule, type RouterConfig } from "./route";

export type { Capability, CapabilityCheck } from "./capabilities";

const home = homedir();
const bun = join(home, ".bun/bin/bun");
const markdownApp = "/Applications/Genesis.app/Contents/Helpers/Genesis Markdown.app";
const mailScript = join(home, ".agents/skills/mail/scripts/open-in-mail.ts");
const rohlikScript = join(home, ".agents/skills/rohlik/scripts/rohlik.ts");
const toolsBin = join(import.meta.dir, "..", "..", "..", "tools");

/** The link `handoff_post` mints, query and all: a route anchored at `/run$` must not count. */
export const CMUX_LAUNCH_URL = "https://genesis.tools/cmux/claude/run";
const CMUX_LAUNCH_PROBE = `${CMUX_LAUNCH_URL}?name=handoff%20probe&prompt=probe&surface=new&cwd=%2Ftmp`;
/** `decide/<session>/<n>/<letter>`: nothing else matches, so a link cannot carry free text. */
export const DECIDE_PATTERN = "https?://genesis\\.tools/decide/([A-Za-z0-9_-]{1,64})/(\\d{1,6})/([a-z])";

export interface PresetSpec {
    id: string;
    title: string;
    /** Every capability must hold before `install` writes the routes. */
    enabledIf: Capability[];
    /** Never written by `install`: the user adds it on purpose (`tools browser-router presets enable <id>`). */
    optIn?: boolean;
    /** A link this preset serves. `presetRouted` checks that the saved config really sends it here. */
    probe?: string;
    routes: RouteRule[];
}

export interface Preset extends PresetSpec {
    /** Every capability in `enabledIf` holds on this Mac. */
    available: boolean;
    /** Available and not opt-in, so `install` keeps its routes in the config. */
    installed: boolean;
}

function catalog(): PresetSpec[] {
    return [
        {
            id: "genesis-md",
            title: "Genesis Markdown",
            enabledIf: [`file:${markdownApp}`],
            routes: [
                {
                    preset: "genesis-md",
                    pattern: "https?://(?:localhost|127\\.0\\.0\\.1):6666/(?!rohlik/|mail/)(.*)",
                    action: { type: "open", to: "genesis-md://$1" },
                },
            ],
        },
        {
            id: "mail",
            title: "Mail",
            enabledIf: [`file:${mailScript}`],
            routes: [
                {
                    preset: "mail",
                    pattern: "https?://genesis\\.tools/mail/show/(\\d+)",
                    action: {
                        type: "run",
                        argv: [bun, mailScript, "$1"],
                        approval: "allow",
                        notify: "Opened mail $1",
                    },
                },
            ],
        },
        {
            id: "decide",
            title: "Claude decision answer",
            // Opt-in: the route types an answer into a live session with approval allow, so it is
            // switched on by hand. The URL carries only a session id, a number and one letter.
            enabledIf: ["claude:installed"],
            optIn: true,
            probe: "https://genesis.tools/decide/00000000-0000-4000-8000-000000000000/1/a",
            routes: [
                {
                    preset: "decide",
                    name: "Answer a decision",
                    pattern: DECIDE_PATTERN,
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
            ],
        },
        {
            id: "cmux-claude",
            title: "Claude in cmux",
            enabledIf: ["cmux:installed", "browser-router:installed"],
            probe: CMUX_LAUNCH_PROBE,
            routes: [
                {
                    preset: "cmux-claude",
                    name: "Run Claude in cmux",
                    pattern: "https?://genesis\\.tools/cmux/claude/run",
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
            ],
        },
        {
            id: "artifact",
            title: "Artifacts",
            enabledIf: [`file:${toolsBin}`],
            routes: [
                {
                    preset: "artifact",
                    name: "Open artifact",
                    // /artifact/<registered name>/<page>; the name charset keeps a link from smuggling flags.
                    pattern: "https?://genesis\\.tools/artifact/([A-Za-z0-9][A-Za-z0-9._-]*)/?([^?#]*)(?:[?#].*)?",
                    action: {
                        type: "run",
                        // `--` keeps a page that starts with a hyphen from being read as a flag.
                        argv: [toolsBin, "artifact", "open", "--", "$1", "$2"],
                        approval: "allow",
                        notify: "Opened artifact $1",
                    },
                },
            ],
        },
        {
            id: "rohlik",
            title: "Rohlik",
            enabledIf: [`file:${rohlikScript}`],
            routes: [
                rohlik(
                    "https?://(?:127\\.0\\.0\\.1|localhost):8787/add/(\\d+)",
                    ["add", "$1", "--qty", "{qty}"],
                    "Added ×{qty} · $1"
                ),
                rohlik(
                    "https?://genesis\\.tools/rohlik/add/(\\d+)",
                    ["add", "$1", "--qty", "{qty}"],
                    "Added ×{qty} · $1"
                ),
                rohlik("https?://(?:127\\.0\\.0\\.1|localhost):8787/ignore/(\\d+)", ["ignore", "$1"], "Ignored $1"),
                rohlik("https?://genesis\\.tools/rohlik/ignore/(\\d+)", ["ignore", "$1"], "Ignored $1"),
                // The ids come from the query string: after `--` a value like `--force` stays an id.
                rohlik(
                    "https?://(?:127\\.0\\.0\\.1|localhost):8787/add-many",
                    ["add", "--qty", "{qty}", "--", "{ids*}"],
                    "Added {ids}"
                ),
                rohlik(
                    "https?://genesis\\.tools/rohlik/add-many",
                    ["add", "--qty", "{qty}", "--", "{ids*}"],
                    "Added {ids}"
                ),
            ],
        },
    ];
}

/** Same shape as genesis-md: a path on genesis.tools that maps back to one installed app. Hidden when that app is missing. */
export function presets(check: CapabilityCheck = hasCapability): Preset[] {
    return catalog().map((spec) => {
        const available = spec.enabledIf.every((capability) => check(capability));
        return { ...spec, available, installed: available && spec.optIn !== true };
    });
}

export function presetById(id: string, check: CapabilityCheck = hasCapability): Preset | undefined {
    return presets(check).find((preset) => preset.id === id);
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
 * or whose action changed (an older `install`, a hand edit), and one per saved route whose pattern the
 * preset no longer ships (it still matches first). Empty when the preset is not in the config at all,
 * since then nothing drifted, it is simply off.
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

export function applyPresets(routes: RouteRule[], catalog: Preset[] = presets()): RouteRule[] {
    const installed = new Set(catalog.filter((preset) => preset.installed).map((preset) => preset.id));
    const current = new Map(catalog.map((preset) => [preset.id, new Set(preset.routes.map((route) => route.pattern))]));
    // A tagged route belongs to its preset: it goes when the app is missing or the preset no longer
    // ships that pattern (the current one is added below). An untagged route is the user's and stays,
    // except the legacy catch-all the genesis-md preset replaced. An opt-in preset the user enabled
    // stays while its capabilities hold.
    const enabledOptIn = new Set(
        catalog.filter(
            (preset) => preset.optIn === true && preset.available && routes.some((route) => route.preset === preset.id)
        )
    );
    const kept = new Set([...installed, ...[...enabledOptIn].map((preset) => preset.id)]);
    const next = routes
        .filter((route) => {
            if (route.preset !== undefined) {
                return kept.has(route.preset) && current.get(route.preset)?.has(route.pattern) === true;
            }

            const legacy =
                route.pattern === LEGACY_LOCAL_CATCH_ALL &&
                route.action.type === "open" &&
                route.action.to === "genesis-md://$1";

            return !legacy;
        })
        .map((route) => ({ ...route }));

    for (const preset of catalog) {
        const enabled = preset.installed || enabledOptIn.has(preset);

        if (!enabled) {
            continue;
        }

        for (const route of preset.routes) {
            const index = next.findIndex((item) => item.pattern === route.pattern);

            if (index === -1) {
                next.push(route);
                continue;
            }

            // A tagged route belongs to the catalog and follows it, so a changed preset (a new flag)
            // reaches configs saved before. An untagged route with the same pattern is the user's and wins.
            if (next[index]?.preset === preset.id) {
                next[index] = { ...route };
            }
        }
    }

    return next;
}

function rohlik(pattern: string, args: string[], notify: string): RouteRule {
    return {
        preset: "rohlik",
        pattern,
        action: {
            type: "run",
            argv: [bun, rohlikScript, ...args],
            approval: "allow",
            notify,
        },
    };
}
