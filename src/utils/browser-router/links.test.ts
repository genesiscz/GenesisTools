import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { linkFor, mintLink, planMintedLink, presetEnabled } from "./links";
import { presets } from "./presets";
import { defaultRouterConfig } from "./route";
import { type RouterStatus, routerStatus } from "./status";
import { takeToken } from "./tokens";

function status(overrides: Partial<RouterStatus> = {}): RouterStatus {
    return {
        installed: true,
        defaultHandler: true,
        httpsHandler: "com.genesiscz.genesistools",
        appPath: "/Applications/Example.app",
        configPath: "/tmp/config.json",
        configured: true,
        linkHost: "links.example.test",
        extension: false,
        presets: [],
        enabledPresets: ["cmux-claude"],
        ...overrides,
    };
}

const params = { presetId: "cmux-claude", path: "x", label: "Run" };

describe("linkFor", () => {
    test("returns null when the router app is not installed", () => {
        expect(linkFor(params, status({ installed: false }))).toBeNull();
    });

    test("returns null when another app handles https, because the link would leave this Mac", () => {
        expect(linkFor(params, status({ defaultHandler: false, httpsHandler: "com.example.browser" }))).toBeNull();
    });

    test("returns null without a link host", () => {
        expect(linkFor(params, status({ linkHost: null }))).toBeNull();
    });

    test("returns null when the preset is off", () => {
        expect(presetEnabled("cmux-claude", status({ enabledPresets: ["mail"] }))).toBe(false);
        expect(linkFor(params, status({ enabledPresets: ["mail"] }))).toBeNull();
    });

    test("returns markdown when the preset is on", () => {
        expect(linkFor(params, status())).toEqual({
            url: "https://links.example.test/x",
            markdown: "[Run](https://links.example.test/x)",
        });
    });
});

describe("routerStatus", () => {
    test("a preset is enabled only when it is switched on and the saved config routes it", () => {
        const config = { ...defaultRouterConfig(), linkHost: "links.example.test", presets: { "cmux-claude": {} } };
        const cmux = routerStatus({ check: () => true, config, handler: "com.genesiscz.genesistools" });

        expect(cmux.defaultHandler).toBe(true);
        expect(cmux.enabledPresets).toEqual([]);
        expect(cmux.presets.find((row) => row.id === "cmux-claude")).toMatchObject({
            available: true,
            enabled: true,
            routed: false,
        });

        const routed = routerStatus({
            check: () => true,
            config: {
                ...config,
                routes: [
                    {
                        preset: "cmux-claude",
                        pattern: "https?://links\\.example\\.test/cmux/claude/run",
                        action: { type: "run", argv: ["tools", "cmux", "launch"], approval: "ask" },
                    },
                ],
            },
            handler: null,
        });

        expect(routed.enabledPresets).toEqual(["cmux-claude"]);
        expect(routed.defaultHandler).toBe(false);
        expect(routerStatus({ check: () => false, config: null, handler: null }).configured).toBe(false);
    });

    test("a routed preset whose saved action lost an argument reports drift", () => {
        const config = { ...defaultRouterConfig(), linkHost: "links.example.test", presets: { "cmux-claude": {} } };
        const preset = presets({ config, check: () => true }).find((row) => row.id === "cmux-claude");
        const own = preset?.routes[0];

        if (!own || own.action.type !== "run") {
            throw new Error("cmux-claude ships one run route");
        }

        const drifted = { ...own, action: { ...own.action, argv: own.action.argv.filter((arg) => arg !== "--open") } };
        const status = routerStatus({
            check: () => true,
            config: { ...config, routes: [drifted] },
            handler: null,
        });
        const row = status.presets.find((item) => item.id === "cmux-claude");

        expect(row).toMatchObject({ routed: true, missing: [] });
        expect(row?.drift).toEqual(["Run Claude in cmux: action differs from the preset"]);

        const clean = routerStatus({
            check: () => true,
            config: { ...config, routes: [own] },
            handler: null,
        });
        expect(clean.presets.find((item) => item.id === "cmux-claude")?.drift).toEqual([]);
    });
});

describe("minted links", () => {
    test("mintLink writes a one-use token; a planned link is not live until it is saved", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-links-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const minted = await mintLink({
                target: "https://links.example.test/done/1",
                label: "Done",
                linkHost: "links.example.test",
            });
            const id = minted.url.split("/t/")[1] ?? "";

            expect(takeToken(id, false)).toEqual({ url: "https://links.example.test/done/1", usesLeft: 1 });

            const planned = planMintedLink({
                target: "https://links.example.test/done/2",
                label: "Done",
                linkHost: "links.example.test",
            });
            const plannedId = planned.link.url.split("/t/")[1] ?? "";

            expect(takeToken(plannedId, false)).toBeNull();
            expect(await planned.save()).toEqual(planned.link);
            expect(takeToken(plannedId, false)?.url).toBe("https://links.example.test/done/2");
        });
    });
});
