import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEGACY_LOCAL_CATCH_ALL, type RouteRule } from "./route";

const home = homedir();
const bun = join(home, ".bun/bin/bun");
const markdownApp = "/Applications/Genesis.app/Contents/Helpers/Genesis Markdown.app";
const mailScript = join(home, ".agents/skills/mail/scripts/open-in-mail.ts");
const rohlikScript = join(home, ".agents/skills/rohlik/scripts/rohlik.ts");
const toolsBin = join(import.meta.dir, "..", "..", "..", "tools");
const cmuxBin = [join(home, ".local/bin/cmux"), "/opt/homebrew/bin/cmux", "/usr/local/bin/cmux"].find((path) =>
    existsSync(path)
);

export interface Preset {
    id: string;
    title: string;
    installed: boolean;
    routes: RouteRule[];
}

/** Same shape as genesis-md: a path on genesis.tools that maps back to one installed app. Hidden when that app is missing. */
export function presets(): Preset[] {
    return [
        {
            id: "genesis-md",
            title: "Genesis Markdown",
            installed: existsSync(markdownApp),
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
            installed: existsSync(mailScript),
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
            // Opt-in, never switched on here: the route types an answer into a live session with
            // approval allow, so a link from anywhere could answer for the user. Add the route by hand
            // (browser-router SKILL.md); `tools claude decide` also lands later in the stack.
            installed: false,
            routes: [
                {
                    preset: "decide",
                    pattern: "https?://genesis\\.tools/decide/:session/:n/:letter",
                    action: {
                        type: "run",
                        argv: [
                            "tools",
                            "claude",
                            "decide",
                            "--session",
                            "{session}",
                            "--decision",
                            "{n}",
                            "--option",
                            "{letter}",
                        ],
                        approval: "allow",
                        notify: "DECISION {n}: {letter})",
                    },
                },
            ],
        },
        {
            id: "cmux-claude",
            title: "Claude in cmux",
            installed: cmuxBin !== undefined,
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
            installed: existsSync(toolsBin),
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
            installed: existsSync(rohlikScript),
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

export function applyPresets(routes: RouteRule[], catalog: Preset[] = presets()): RouteRule[] {
    const installed = new Set(catalog.filter((preset) => preset.installed).map((preset) => preset.id));
    const current = new Map(catalog.map((preset) => [preset.id, new Set(preset.routes.map((route) => route.pattern))]));
    // A tagged route belongs to its preset: it goes when the app is missing or the preset no longer
    // ships that pattern (the current one is added below). An untagged route is the user's and stays,
    // except the legacy catch-all the genesis-md preset replaced.
    const next = routes
        .filter((route) => {
            if (route.preset !== undefined) {
                return installed.has(route.preset) && current.get(route.preset)?.has(route.pattern) === true;
            }

            const legacy =
                route.pattern === LEGACY_LOCAL_CATCH_ALL &&
                route.action.type === "open" &&
                route.action.to === "genesis-md://$1";

            return !legacy;
        })
        .map((route) => ({ ...route }));

    for (const preset of catalog) {
        if (!preset.installed) {
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
