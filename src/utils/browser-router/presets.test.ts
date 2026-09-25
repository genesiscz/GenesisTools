import { describe, expect, test } from "bun:test";
import type { Capability } from "./capabilities";
import { applyPresets, type Preset, presetById, presetRouted, presets } from "./presets";
import { defaultRouterConfig, LEGACY_LOCAL_CATCH_ALL, type RouteRule, type RouterConfig, route } from "./route";

const genesis: Preset = {
    id: "genesis-md",
    title: "Genesis Markdown",
    enabledIf: ["file:/Applications/Example.app"],
    available: true,
    installed: true,
    routes: [
        {
            preset: "genesis-md",
            pattern: "https?://127.0.0.1:6666/md/(.*)",
            action: { type: "open", to: "genesis-md://$1" },
        },
    ],
};

describe("applyPresets", () => {
    test("hides a preset whose app is not installed", () => {
        const routes: RouteRule[] = [
            {
                preset: "genesis-md",
                pattern: "https?://127.0.0.1:6666/(.*)",
                action: { type: "open", to: "genesis-md://$1" },
            },
            { pattern: "https://example.com/.*", action: { type: "forward", browser: "Safari" } },
        ];
        const hidden = applyPresets(routes, [{ ...genesis, available: false, installed: false }]);

        expect(hidden.map((route) => route.pattern)).toEqual(["https://example.com/.*"]);
    });

    test("adds the preset route when the app is installed", () => {
        const added = applyPresets([], [genesis]);

        expect(added).toEqual(genesis.routes);
    });

    test("a saved preset route follows the catalog; an untagged route with the same pattern stays the user's", () => {
        const pattern = "https?://127.0.0.1:6666/md/(.*)";
        const stale: RouteRule = { preset: "genesis-md", pattern, action: { type: "open", to: "genesis-md://old/$1" } };
        const users: RouteRule = { pattern, action: { type: "open", to: "genesis-md://mine/$1" } };

        expect(applyPresets([stale], [genesis])).toEqual(genesis.routes);
        expect(applyPresets([users], [genesis])).toEqual([users]);
    });
});

describe("applyPresets keeps the user's routes", () => {
    test("a user route to genesis-md survives; the legacy catch-all and a stale preset pattern go", () => {
        const user: RouteRule = {
            pattern: "https?://genesis\\.tools/open-genesis/(.*)",
            action: { type: "open", to: "genesis-md://$1" },
        };
        const routes: RouteRule[] = [
            user,
            { pattern: LEGACY_LOCAL_CATCH_ALL, action: { type: "open", to: "genesis-md://$1" } },
            {
                preset: "genesis-md",
                pattern: "https?://127.0.0.1:6666/old/(.*)",
                action: { type: "open", to: "genesis-md://$1" },
            },
        ];

        expect(applyPresets(routes, [genesis]).map((route) => route.pattern)).toEqual([
            user.pattern,
            "https?://127.0.0.1:6666/md/(.*)",
        ]);
        expect(
            applyPresets(routes, [{ ...genesis, available: false, installed: false }]).map((route) => route.pattern)
        ).toEqual([user.pattern]);
    });
});

describe("capabilities", () => {
    const all = (value: boolean) => () => value;

    test("a preset is installed only when every capability holds", () => {
        const on = presets(all(true));
        const off = presets(all(false));

        expect(on.find((preset) => preset.id === "cmux-claude")?.installed).toBe(true);
        expect(off.every((preset) => !preset.installed && !preset.available)).toBe(true);
    });

    test("cmux-claude needs both cmux and the router app", () => {
        const only = (capability: Capability) => (asked: Capability) => asked === capability;

        expect(presetById("cmux-claude", only("cmux:installed"))?.installed).toBe(false);
        expect(presetById("cmux-claude", only("browser-router:installed"))?.installed).toBe(false);
    });

    test("an opt-in preset is never installed, even when available, and stays once the user enabled it", () => {
        const decide = presetById("decide", all(true));

        expect(decide?.available).toBe(true);
        expect(decide?.installed).toBe(false);
        expect(applyPresets([], presets(all(true))).some((route) => route.preset === "decide")).toBe(false);

        const enabled = decide?.routes ?? [];
        expect(applyPresets(enabled, presets(all(true))).filter((route) => route.preset === "decide")).toEqual(enabled);
        expect(applyPresets(enabled, presets(all(false))).some((route) => route.preset === "decide")).toBe(false);
    });

    test("existing presets keep their routes: the same patterns as before capabilities existed", () => {
        const ids = presets(all(true))
            .filter((preset) => preset.installed)
            .map((preset) => preset.id);

        expect(ids).toEqual(["genesis-md", "mail", "cmux-claude", "artifact", "rohlik"]);
        expect(presetById("mail", all(true))?.routes[0]?.pattern).toBe("https?://genesis\\.tools/mail/show/(\\d+)");
    });
});

const LINK = "https?://genesis\\.tools/cmux/claude/run";
const open: RouteRule["action"] = { type: "open", to: "https://example.com/" };
const launch: RouteRule["action"] = { type: "run", argv: ["tools", "cmux", "launch", "--open"], approval: "allow" };

function withRoutes(...routes: RouteRule[]): RouterConfig {
    return { ...defaultRouterConfig(), routes };
}

describe("presetRouted", () => {
    const cmux = presetById("cmux-claude", () => true);

    if (!cmux) {
        throw new Error("the catalog has no cmux-claude preset");
    }

    test("the first route matching the link decides, and it must launch cmux", () => {
        expect(presetRouted(withRoutes({ pattern: LINK, preset: "cmux-claude", action: launch }), cmux)).toBe(true);
        expect(presetRouted(withRoutes({ pattern: LINK, action: launch }), cmux)).toBe(true);
        expect(presetRouted(withRoutes({ pattern: LINK, action: open }), cmux)).toBe(false);
        // Anchored at `run$`: it matches the bare URL but not a minted link with its query.
        expect(
            presetRouted(withRoutes({ pattern: "^https://genesis\\.tools/cmux/claude/run$", action: launch }), cmux)
        ).toBe(false);
        expect(
            presetRouted(
                withRoutes(
                    { pattern: "https?://genesis\\.tools/.*", action: open },
                    { pattern: LINK, preset: "cmux-claude", action: launch }
                ),
                cmux
            )
        ).toBe(false);
    });

    test("a route that only mentions the link in its name, or no route at all, does not enable it", () => {
        expect(
            presetRouted(
                withRoutes({ pattern: "^https://docs\\.example/", name: "about cmux/claude/run", action: open }),
                cmux
            )
        ).toBe(false);
        expect(presetRouted(defaultRouterConfig(), cmux)).toBe(false);
    });
});

describe("decide preset route", () => {
    const decide = presetById("decide", () => true);
    const config = withRoutes(...(decide?.routes ?? []));
    const session = "3f2a9c1e-0000-4000-8000-00000000abcd";

    test("a session id, a number and one letter become the decide command", () => {
        const decision = route(`https://genesis.tools/decide/${session}/4/b`, config);

        expect(decision).toMatchObject({
            kind: "run",
            argv: [
                "tools",
                "claude",
                "decide",
                "--session",
                session,
                "--decision",
                "4",
                "--option",
                "b",
                "--question",
                "",
            ],
            needsApproval: false,
            notify: "Answered DECISION 4: b)",
        });
        expect(route(`https://genesis.tools/decide/${session}/4/b?q=ask_1`, config)).toMatchObject({
            argv: [
                "tools",
                "claude",
                "decide",
                "--session",
                session,
                "--decision",
                "4",
                "--option",
                "b",
                "--question",
                "ask_1",
            ],
        });
    });

    test("extra path segments, text in the option, or a non-number never match", () => {
        for (const url of [
            `https://genesis.tools/decide/${session}/4/b/extra`,
            `https://genesis.tools/decide/${session}/4/bb`,
            `https://genesis.tools/decide/${session}/4/b%20and%20more`,
            `https://genesis.tools/decide/${session}/four/b`,
            `https://genesis.tools/decide/a%20b/4/b`,
        ]) {
            expect({ url, kind: route(url, config).kind }).toEqual({ url, kind: "forward" });
        }
    });
});
