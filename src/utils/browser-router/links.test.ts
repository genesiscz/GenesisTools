import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { type LinkGate, linkGate, linkGatePath } from "./link-gate";
import { linkFor, mintLink, planMintedLink, presetEnabled } from "./links";
import { presets } from "./presets";
import { defaultRouterConfig } from "./route";
import { routerLink, schemeLink } from "./router-link";
import { type RouterStatus, routerStatus } from "./status";
import { mintToken, takeToken, tokenFile, withTokenLock } from "./tokens";

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

describe("token file", () => {
    const corruptCopies = (path: string): string[] =>
        readdirSync(dirname(path)).filter((name) => name.startsWith("tokens.json.corrupt-"));
    const plant = (text: string): string => {
        const path = tokenFile();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, { mode: 0o600 });
        return path;
    };

    test("a token file that is not JSON is copied aside before the next mint replaces it", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-tokens-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const truncated = '{\n  "abcdefgh": { "url": "https://links.example.test/a", "usesLeft": 2 },\n  "ijkl';
            const path = plant(truncated);

            expect(takeToken("abcdefgh", false)).toBeNull();
            expect(corruptCopies(path)).toEqual([]);

            const id = await withTokenLock(() => mintToken("https://links.example.test/b", 1));

            const copies = corruptCopies(path);
            expect(copies.length).toBe(1);
            expect(readFileSync(join(dirname(path), copies[0] ?? ""), "utf8")).toBe(truncated);
            expect(takeToken(id, false)?.url).toBe("https://links.example.test/b");
        });
    });

    test("a valid token file keeps every token when another is minted", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-tokens-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const path = plant('{ "abcdefgh": { "url": "https://links.example.test/a", "usesLeft": 2 } }\n');

            const id = await withTokenLock(() => mintToken("https://links.example.test/b", 1));

            expect(takeToken("abcdefgh", false)).toEqual({ url: "https://links.example.test/a", usesLeft: 2 });
            expect(takeToken(id, false)?.url).toBe("https://links.example.test/b");
            expect(corruptCopies(path)).toEqual([]);
        });
    });

    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "a token file that cannot be read throws instead of reading as empty",
        async () => {
            const home = mkdtempSync(join(tmpdir(), "browser-router-tokens-"));
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
                const original = '{ "abcdefgh": { "url": "https://links.example.test/a", "usesLeft": 2 } }\n';
                const path = plant(original);
                chmodSync(path, 0o200);

                try {
                    expect(() => takeToken("abcdefgh", false)).toThrow(/EACCES/);
                    await expect(withTokenLock(() => mintToken("https://links.example.test/b", 1))).rejects.toThrow(
                        /EACCES/
                    );
                } finally {
                    chmodSync(path, 0o600);
                }

                expect(readFileSync(path, "utf8")).toBe(original);
            });
        }
    );
});

describe("routerLink and the link gate", () => {
    const routed: LinkGate = {
        version: 2,
        at: 0,
        configMtimeMs: 0,
        installed: true,
        defaultHandler: true,
        httpsHandler: "com.example.router",
        configured: true,
        linkHost: "genesis.tools",
        presets: {
            "genesis-md": { available: true, enabled: true, routed: true, missing: [] },
            "genesis-hub": { available: true, enabled: false, routed: false, missing: [] },
        },
    };
    const open = (gate: LinkGate) =>
        routerLink({
            preset: "genesis-md",
            action: "open",
            data: { path: "/a b/c&d.md", range: "3-9" },
            gate,
            fallback: () => "PLAIN",
        });

    test("builds the router link from the preset, with the path readable and the rest encoded", () => {
        expect(open(routed)).toEqual({
            result: "https://genesis.tools/md/open?path=/a%20b/c%26d.md&range=3-9",
            link: "https://genesis.tools/md/open?path=/a%20b/c%26d.md&range=3-9",
            via: "router",
        });
    });

    test.each([
        ["router-missing", { installed: false }],
        ["not-https-handler", { defaultHandler: false }],
        ["no-link-host", { linkHost: null }],
    ] as const)("falls back with %s", (code, change) => {
        const result = open({ ...routed, ...change });

        expect(result.result).toBe("PLAIN");
        expect(result.link).toBeNull();
        expect(result.error?.code).toBe(code);
    });

    test("falls back for a preset that is off, and names why", () => {
        const result = routerLink({
            preset: "genesis-hub",
            action: "open",
            data: { pr: "acme/app#7" },
            via: ["router"],
            gate: routed,
            fallback: () => "none",
        });

        expect(result.result).toBe("none");
        expect(result.error).toMatchObject({ code: "preset-off" });
        expect(result.error?.reason).toContain("off in the config");
    });

    test("tries the app's own link next when asked, and passes the link to render", () => {
        const result = routerLink({
            preset: "genesis-md",
            action: "open",
            data: { path: "/a.md" },
            via: ["router", "scheme"],
            gate: { ...routed, defaultHandler: false },
            render: ({ link, via }) => `[a.md](${link}) via ${via}`,
            fallback: () => "a.md",
        });

        expect(result.result).toBe("[a.md](genesis-md://open?path=/a.md) via scheme");
    });

    test("when() can decline", () => {
        expect(open({ ...routed }).error).toBeUndefined();
        expect(
            routerLink({
                preset: "genesis-md",
                action: "open",
                data: { path: "/a.md" },
                gate: routed,
                when: () => false,
                fallback: () => "no",
            }).error?.code
        ).toBe("declined");
    });

    test("opens genesis-md by scheme when the app is installed and the router has no link host", () => {
        const catalogue = presets({ config: { ...defaultRouterConfig(), presets: {} }, check: () => true });
        const row = catalogue.find((item) => item.id === "genesis-md");

        expect(row?.available).toBe(false);
        expect(row?.missing.some((item) => item.startsWith("app:"))).toBe(false);

        const gate: LinkGate = {
            ...routed,
            linkHost: null,
            presets: {
                "genesis-md": {
                    available: false,
                    enabled: false,
                    routed: false,
                    missing: row?.missing ?? [],
                },
            },
        };
        const openMd = (via: Array<"router" | "scheme">) =>
            routerLink({
                preset: "genesis-md",
                action: "open",
                data: { path: "/a.md" },
                via,
                gate,
                fallback: () => "PLAIN",
            });

        expect(openMd(["scheme"]).link).toBe("genesis-md://open?path=/a.md");
        expect(openMd(["router", "scheme"])).toMatchObject({
            via: "scheme",
            link: "genesis-md://open?path=/a.md",
        });
    });

    test("refuses a genesis-md scheme link when the app itself is missing", () => {
        const catalogue = presets({
            config: { ...defaultRouterConfig(), presets: {} },
            check: (capability) => !String(capability).startsWith("app:"),
        });
        const row = catalogue.find((item) => item.id === "genesis-md");

        expect(row?.missing.some((item) => item.startsWith("app:"))).toBe(true);

        const result = routerLink({
            preset: "genesis-md",
            action: "open",
            data: { path: "/a.md" },
            via: ["scheme"],
            gate: {
                ...routed,
                linkHost: null,
                presets: {
                    "genesis-md": {
                        available: row?.available ?? false,
                        enabled: false,
                        routed: false,
                        missing: row?.missing ?? [],
                    },
                },
            },
            fallback: () => "PLAIN",
        });

        expect(result.link).toBeNull();
        expect(result.error?.code).toBe("app-missing");
    });

    test("the hub link takes the router where its preset routes, and the app scheme where none does", () => {
        const data = { pr: "acme/app#7" };
        const hub = (gate: LinkGate) =>
            routerLink({ preset: "genesis-hub", action: "open", data, gate, fallback: () => "none" });
        const hubRouted: LinkGate = {
            ...routed,
            presets: {
                ...routed.presets,
                "genesis-hub": { available: true, enabled: true, routed: true, missing: [] },
            },
        };
        const noHubPreset: LinkGate = {
            ...routed,
            presets: Object.fromEntries(Object.entries(routed.presets).filter(([id]) => id !== "genesis-hub")),
        };

        expect(hub(hubRouted)).toMatchObject({ via: "router", link: "https://genesis.tools/hub?pr=acme%2Fapp%237" });
        expect(hub(routed)).toMatchObject({ via: "scheme", link: "genesis-tools://hub?pr=acme%2Fapp%237" });
        expect(hub(noHubPreset)).toMatchObject({ via: "scheme", link: "genesis-tools://hub?pr=acme%2Fapp%237" });

        const forced = routerLink({
            preset: "genesis-hub",
            action: "open",
            data,
            via: ["router"],
            gate: noHubPreset,
            fallback: () => "none",
        });

        expect(forced.error?.code).toBe("preset-off");
        expect(forced.error?.reason).toContain("no such preset");
    });

    test("the hub link keeps the app's strict encoding", () => {
        expect(
            schemeLink({ preset: "genesis-hub", action: "open", data: { pr: "acme/app#7", commit: "abc1234" } })
        ).toBe("genesis-tools://hub?pr=acme%2Fapp%237&commit=abc1234");
    });

    test("answers from a fresh gate file, and recomputes a stale or old-format one", () => {
        const cached = { ...routed, at: Date.now(), configMtimeMs: 0, linkHost: "cached.example" };

        mkdirSync(dirname(linkGatePath()), { recursive: true });
        writeFileSync(linkGatePath(), SafeJSON.stringify(cached));
        expect(linkGate().linkHost).toBe("cached.example");

        writeFileSync(linkGatePath(), SafeJSON.stringify({ ...cached, at: Date.now() - 60 * 60_000 }));
        expect(linkGate().linkHost).not.toBe("cached.example");

        writeFileSync(
            linkGatePath(),
            SafeJSON.stringify({ at: Date.now(), configMtimeMs: 0, linkHost: "old.example", enabledPresets: [] })
        );
        expect(linkGate().linkHost).not.toBe("old.example");
    });
});
