import { describe, expect, test } from "bun:test";
import type { Capability } from "./capabilities";
import { applyPresets, presetById, presetRouted, presets } from "./presets";
import { defaultRouterConfig, type RouteRule, type RouterConfig, route } from "./route";

const LINK_HOST = "links.example.test";
const all = (value: boolean) => () => value;

function configWith(chosen: RouterConfig["presets"], linkHost: string | null = LINK_HOST): RouterConfig {
    return { ...defaultRouterConfig(), ...(linkHost ? { linkHost } : {}), presets: chosen };
}

function ids(config: RouterConfig, check = all(true)): string[] {
    return presets({ config, check })
        .filter((preset) => preset.enabled)
        .map((preset) => preset.id);
}

describe("preset kinds", () => {
    test("only the default core preset is on until an installable one is enabled", () => {
        expect(ids(configWith({}))).toEqual(["core"]);
        expect(ids(configWith({ decide: {}, "local-services": {} }))).toEqual(["core", "local-services", "decide"]);
    });

    test("presets on the link host are unavailable without one, and say why", () => {
        const catalogue = presets({ config: configWith({ decide: {} }, null), check: all(true) });

        expect(catalogue.filter((preset) => preset.enabled).map((preset) => preset.id)).toEqual([]);
        expect(presetById("decide", catalogue)?.missing).toEqual([
            "a link host (tools browser-router link-host <host>)",
        ]);
        // local-services needs no link host.
        expect(ids(configWith({ "local-services": {} }, null))).toEqual(["local-services"]);
    });

    test("cmux-claude needs both cmux and the router app, and mail needs macOS", () => {
        const only = (capability: Capability) => (asked: Capability) => asked === capability;
        const config = configWith({ "cmux-claude": {}, mail: {} });

        expect(presetById("cmux-claude", presets({ config, check: only("cmux:installed") }))?.enabled).toBe(false);
        expect(
            presetById("cmux-claude", presets({ config, check: only("browser-router:installed") }))?.missing
        ).toEqual(["cmux:installed"]);
        expect(presetById("mail", presets({ config, check: only("platform:darwin") }))?.enabled).toBe(true);
    });

    test("the catalog ships no personal presets", () => {
        const catalogue = presets({ config: configWith({}), check: all(true) }).map((preset) => preset.id);

        expect(catalogue).toEqual([
            "core",
            "local-services",
            "genesis-md",
            "mail",
            "decide",
            "cmux-claude",
            "artifact",
            "dashboard-names",
        ]);
    });
});

describe("applyPresets", () => {
    const user: RouteRule = { pattern: "https://example.com/.*", action: { type: "forward", browser: "Safari" } };

    test("default routes first, the user's own next, installable last; a tagged route not enabled goes", () => {
        const config = configWith({ "genesis-md": {} });
        const stale: RouteRule = { preset: "decide", pattern: "https?://old/(.*)", action: { type: "open", to: "x" } };
        const routes = applyPresets([stale, user], presets({ config, check: all(true) }));

        expect(routes.map((rule) => rule.preset ?? "user")).toEqual(["core", "core", "core", "user", "genesis-md"]);
    });

    test("a user route with a preset's pattern replaces the preset's", () => {
        const config = configWith({ "genesis-md": {} });
        const pattern = presetById("genesis-md", presets({ config, check: all(true) }))?.routes[0]?.pattern ?? "";
        const mine: RouteRule = { pattern, action: { type: "open", to: "genesis-md://mine/$1" } };
        const routes = applyPresets([mine], presets({ config, check: all(true) }));

        expect(routes.filter((rule) => rule.pattern === pattern)).toEqual([mine]);
    });

    test("an enabled preset whose capability went away drops its routes", () => {
        const config = configWith({ decide: {} });

        expect(applyPresets([], presets({ config, check: all(false) })).some((rule) => rule.preset === "decide")).toBe(
            false
        );
    });
});

describe("presetRouted", () => {
    const config = configWith({ "cmux-claude": {} });
    const cmux = presetById("cmux-claude", presets({ config, check: all(true) }));
    const LINK = "https?://links\\.example\\.test/cmux/claude/run";
    const open: RouteRule["action"] = { type: "open", to: "https://example.com/" };
    const launch: RouteRule["action"] = { type: "run", argv: ["tools", "cmux", "launch", "--open"], approval: "allow" };
    const withRoutes = (...routes: RouteRule[]): RouterConfig => ({ ...config, routes });

    if (!cmux) {
        throw new Error("the catalog has no cmux-claude preset");
    }

    test("the first route matching the link decides, and it must launch cmux", () => {
        expect(presetRouted(withRoutes({ pattern: LINK, preset: "cmux-claude", action: launch }), cmux)).toBe(true);
        expect(presetRouted(withRoutes({ pattern: LINK, action: launch }), cmux)).toBe(true);
        expect(presetRouted(withRoutes({ pattern: LINK, action: open }), cmux)).toBe(false);
        // Anchored at `run$`: it matches the bare URL but not a minted link with its query.
        expect(
            presetRouted(
                withRoutes({ pattern: "^https://links\\.example\\.test/cmux/claude/run$", action: launch }),
                cmux
            )
        ).toBe(false);
        expect(
            presetRouted(
                withRoutes(
                    { pattern: "https?://links\\.example\\.test/.*", action: open },
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
        expect(presetRouted(withRoutes(), cmux)).toBe(false);
    });
});

describe("decide preset route", () => {
    const base = configWith({ decide: {} });
    const config = { ...base, routes: applyPresets([], presets({ config: base, check: all(true) })) };
    const session = "3f2a9c1e-0000-4000-8000-00000000abcd";

    test("a session id, a number and one letter become the decide command", () => {
        const decision = route(`https://links.example.test/decide/${session}/4/b`, config);

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
        expect(route(`https://links.example.test/decide/${session}/4/b?q=ask_1`, config)).toMatchObject({
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
            `https://links.example.test/decide/${session}/4/b/extra`,
            `https://links.example.test/decide/${session}/4/bb`,
            `https://links.example.test/decide/${session}/4/b%20and%20more`,
            `https://links.example.test/decide/${session}/four/b`,
            `https://links.example.test/decide/a%20b/4/b`,
        ]) {
            expect({ url, kind: route(url, config).kind }).toEqual({ url, kind: "forward" });
        }
    });

    test("the mail preset runs tools macos mail open", () => {
        const mailBase = configWith({ mail: {} });
        const mail = { ...mailBase, routes: applyPresets([], presets({ config: mailBase, check: all(true) })) };

        expect(route("https://links.example.test/mail/show/4711", mail)).toMatchObject({
            kind: "run",
            argv: ["tools", "macos", "mail", "open", "4711"],
        });
    });
});
