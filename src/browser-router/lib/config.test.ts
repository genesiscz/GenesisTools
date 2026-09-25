import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tokenLink } from "@genesiscz/utils/browser-router/links";
import { presetById } from "@genesiscz/utils/browser-router/presets";
import { defaultRouterConfig, type RouterConfig, route } from "@genesiscz/utils/browser-router/route";
import { routerStatus } from "@genesiscz/utils/browser-router/status";
import {
    mintBundleToken,
    mintToken,
    takeToken,
    tokenFile,
    withTokenLock,
} from "@genesiscz/utils/browser-router/tokens";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage";
import { deleteRoute, enablePreset, loadConfig, routeFromFlags, saveConfig, upsertRoute } from "./config";
import { openMintedLink, openUrl, redeemMintedLink, runChecked } from "./launch";
import { convertMarkdown } from "./links";
import { bundleLink, bundleUrls, openBundle, saveBundle, TAB_CAP } from "./tabs";

function mint(url: string, uses: number): Promise<string> {
    return withTokenLock(() => mintToken(url, uses));
}

describe("config", () => {
    test("concurrent route saves all land, because load and save share one lock", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await saveConfig(defaultRouterConfig("Safari"));
            const patterns = [1, 2, 3, 4, 5].map((n) => `https://genesis\\.tools/race/${n}`);
            await Promise.all(
                patterns.map((pattern) => upsertRoute({ pattern, action: { type: "open", to: "genesis-md://x" } }))
            );
            const saved = (await loadConfig())?.routes.map((item) => item.pattern) ?? [];

            expect(patterns.filter((pattern) => !saved.includes(pattern))).toEqual([]);
        });
    });

    test("round-trips and a new route replaces the same pattern", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await saveConfig(defaultRouterConfig({ name: "Example Browser", appType: "appName" }));
            await upsertRoute({
                pattern: "https://genesis.tools/open-genesis/(.*)",
                action: { type: "open", to: "genesis-md://$1" },
            });
            await upsertRoute({
                pattern: "https://genesis.tools/open-genesis/(.*)",
                action: { type: "open", to: "genesis-md://again/$1" },
            });
            const loaded = await loadConfig();

            const defaults = defaultRouterConfig().routes.length;
            expect(loaded?.routes).toHaveLength(defaults + 1);
            expect(loaded?.routes.at(-1)?.action).toEqual({ type: "open", to: "genesis-md://again/$1" });
            expect(route("https://genesis.tools/open-genesis/open", loaded!).url).toBe("genesis-md://again/open");

            await deleteRoute("https://genesis.tools/open-genesis/(.*)");
            expect((await loadConfig())?.routes).toHaveLength(defaults);
        });
    });
});

function mintedConfig(): RouterConfig {
    return {
        ...defaultRouterConfig("Safari"),
        routes: [
            ...defaultRouterConfig("Safari").routes,
            {
                pattern: "https://genesis\\.tools/done/(\\d+)",
                action: { type: "run", argv: ["/usr/bin/true", "$1"], approval: "allow" },
            },
            {
                pattern: "https://genesis\\.tools/ask/(\\d+)",
                action: { type: "run", argv: ["/usr/bin/true", "$1"], approval: "ask" },
            },
        ],
    };
}

describe("minted links", () => {
    test.skipIf(process.platform === "win32")(
        "the token file is private, and an old 0644 file is repaired",
        async () => {
            const home = mkdtempSync(join(tmpdir(), "browser-router-"));
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
                mkdirSync(dirname(tokenFile()), { recursive: true });
                writeFileSync(
                    tokenFile(),
                    `${SafeJSON.stringify({ old: { url: "https://example.com/", usesLeft: 1 } })}\n`,
                    {
                        mode: 0o644,
                    }
                );
                expect(takeToken("old", false)?.url).toBe("https://example.com/");
                expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);

                await mint("https://example.com/next", 1);
                expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
            });
        }
    );

    test("a click spends one use and runs the URL's route; a spent link is refused", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const config = mintedConfig();
            const id = await mint("https://genesis.tools/done/7", 1);

            // explain peeks without spending (the negative control for the spend below).
            expect(route(tokenLink(id), config).kind).toBe("run");
            expect(takeToken(id, false)?.usesLeft).toBe(1);

            const plan = await redeemMintedLink(id, config);
            expect(plan.kind).toBe("perform");
            expect(plan.kind === "perform" && plan.decision.kind === "run" ? plan.decision.argv : []).toEqual([
                "/usr/bin/true",
                "7",
            ]);
            expect(takeToken(id, false)).toBeNull();
            await expect(redeemMintedLink(id, config)).rejects.toThrow("link used up");
        });
    });

    test("links --convert --uses on a genesis-md link opens Genesis Markdown, never the browser", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const config = defaultRouterConfig();
            const converted = await withTokenLock(() =>
                convertMarkdown("[md](genesis-md://open?path=/tmp/a.md) [cursor](cursor://file/a.ts)", 1, config)
            );
            const link = /\[md\]\((https:\/\/genesis\.tools\/t\/[A-Za-z0-9_-]+)\)/.exec(converted)?.[1] ?? "";
            const id = link.split("/t/")[1] ?? "";

            expect(converted).toContain("[cursor](cursor://file/a.ts)");
            // explain (a peek) and the click (token open) take the same way.
            expect(route(link, config)).toMatchObject({ kind: "open", url: "genesis-md://open?path=/tmp/a.md" });
            const plan = await redeemMintedLink(id, config);
            expect(plan.kind === "perform" ? plan.decision : plan).toMatchObject({
                kind: "open",
                openArguments: ["-b", "dev.foltyn.genesis.markdown", "genesis-md://open?path=/tmp/a.md"],
            });

            // Only genesis-md: a minted link for another scheme is refused, as a /link/ one is.
            const other = await mint("x-apple.systempreferences:com.apple.preference.security", 1);
            await expect(redeemMintedLink(other, config)).rejects.toThrow("only http(s) and genesis-md");
        });
    });

    test("a minted link whose route asks goes back to the app, and its use is still spent", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const id = await mint("https://genesis.tools/ask/3", 2);

            expect(await redeemMintedLink(id, mintedConfig())).toEqual({
                kind: "app",
                url: "https://genesis.tools/ask/3",
            });
            expect(takeToken(id, false)?.usesLeft).toBe(1);
        });
    });
});

describe("cmux launch links", () => {
    function launchConfig(): RouterConfig {
        const preset = presetById("cmux-claude", () => true);
        return { ...mintedConfig(), routes: [...(preset?.routes ?? []), ...mintedConfig().routes] };
    }

    const raw = "https://genesis.tools/cmux/claude/run?prompt=do%20the%20handoff&name=handoff%20h_x&surface=new";

    test("a raw link with a prompt never reaches the launch: it asks, and the spawn spy throws if reached", async () => {
        const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
            throw new Error("the launch primitive ran");
        });

        try {
            expect(route(raw, launchConfig())).toMatchObject({ kind: "run", needsApproval: true });
            await expect(openUrl(raw, launchConfig())).rejects.toThrow("asks before it runs");
            expect(spawn).not.toHaveBeenCalled();
        } finally {
            spawn.mockRestore();
        }
    });

    test("the same link minted here skips the card, once", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const id = await mint(raw, 1);
            const plan = await redeemMintedLink(id, launchConfig());

            expect(plan.kind === "perform" ? plan.decision : null).toMatchObject({
                kind: "run",
                needsApproval: false,
                launch: { prompt: "do the handoff", name: "handoff h_x", surface: "new" },
            });
            await expect(redeemMintedLink(id, launchConfig())).rejects.toThrow("link used up");
        });
    });
});

describe("tools browser-router open", () => {
    test("spends a minted link's use; a link that asks is refused before its use is spent", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const config = mintedConfig();
            const allowed = await mint("https://genesis.tools/done/1", 1);
            await openUrl(tokenLink(allowed), config);
            expect(takeToken(allowed, false)).toBeNull();

            const asking = await mint("https://genesis.tools/ask/1", 1);
            await expect(openUrl(tokenLink(asking), config)).rejects.toThrow("asks before it runs");
            expect(takeToken(asking, false)?.usesLeft).toBe(1);
        });
    });
});

describe("routeFromFlags toast", () => {
    test("--no-toast (commander sets toast: false) saves toast: false", () => {
        const flags = { run: "/usr/bin/true", approval: "allow" };

        expect(routeFromFlags("https://genesis.tools/x", { ...flags, toast: false }).toast).toBe(false);
        expect(routeFromFlags("https://genesis.tools/x", { ...flags, toast: true }).toast).toBeUndefined();
    });
});

describe("route --name", () => {
    test("every action kind saves the card headline, and it survives a save and a load", async () => {
        const pattern = "https://genesis.tools/named/(\\d+)";

        expect(routeFromFlags(pattern, { routeTo: "https://example.com/$1", name: "Open item" }).name).toBe(
            "Open item"
        );
        expect(routeFromFlags(pattern, { run: "/usr/bin/true", approval: "allow", name: "Run it" }).name).toBe(
            "Run it"
        );
        expect(routeFromFlags(pattern, { tool: "example", approval: "ask", name: "Tool it" }).name).toBe("Tool it");
        expect(routeFromFlags(pattern, { run: "/usr/bin/true", approval: "allow" })).not.toHaveProperty("name");

        const home = mkdtempSync(join(tmpdir(), "browser-router-name-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await upsertRoute(routeFromFlags(pattern, { run: "/usr/bin/true", approval: "allow", name: "  Run it  " }));
            const saved = (await loadConfig())?.routes.find((rule) => rule.pattern.includes("named"));

            expect(saved?.name).toBe("Run it");
        });
    });
});

describe("token lock", () => {
    test("two clicks at once on a one-use link run it once", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const id = await mint("https://genesis.tools/done/9", 1);
            const results = await Promise.allSettled([
                redeemMintedLink(id, mintedConfig()),
                redeemMintedLink(id, mintedConfig()),
            ]);

            expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
        });
    });

    test("a write outside the lock is refused; a peek is not", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            expect(() => mintToken("https://example.com/", 1)).toThrow("must run inside withTokenLock");
            const id = await mint("https://example.com/", 1);

            expect(takeToken(id, false)?.usesLeft).toBe(1);
            expect(() => takeToken(id, true)).toThrow("must run inside withTokenLock");
        });
    });
});

describe("tab bundles", () => {
    test("a missing file is no bundles; a malformed one is refused and left as it was", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            expect(() => bundleUrls("work")).toThrow("no tab bundle named work");
            await saveBundle("work", ["https://example.com/a"]);
            expect(bundleUrls("work")).toEqual(["https://example.com/a"]);

            const file = join(new Storage("browser-router").getBaseDir(), "bundles.json");
            writeFileSync(file, '{ "work": "https://example.com/a" }');

            await expect(saveBundle("side", ["https://example.com/b"])).rejects.toThrow("is not a map of bundle names");
            expect(readFileSync(file, "utf8")).toBe('{ "work": "https://example.com/a" }');

            writeFileSync(file, "{ broken");
            expect(() => bundleUrls("work")).toThrow();
        });
    });

    test("bundles saved at the same time all land", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const names = ["work", "personal", "shop", "side"];
            await Promise.all(names.map((name) => saveBundle(name, [`https://example.com/${name}`])));

            expect(names.map((name) => bundleUrls(name)[0])).toEqual(
                names.map((name) => `https://example.com/${name}`)
            );
        });
    });

    test("a bundle holds only http(s) links", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await expect(saveBundle("work", ["file:///tmp/x.command"])).rejects.toThrow("is not an http(s) link");
            await expect(saveBundle("work", [])).rejects.toThrow("at least one");
        });
    });

    test("a saved name reaches `tabs open` as the name, never as a flag", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            // The click runs `tools browser-router tabs open <name>`; `-v` there is the root's verbose flag.
            for (const name of ["-v", "--help"]) {
                await expect(saveBundle(name, ["https://example.com/"])).rejects.toThrow("must start with a letter");
            }

            await saveBundle("morning-2", ["https://example.com/"]);
            const decision = route(bundleLink("morning-2"), defaultRouterConfig());
            expect(decision.kind === "run" ? decision.argv : []).toEqual([
                "tools",
                "browser-router",
                "tabs",
                "open",
                "morning-2",
            ]);
        });
    });
});

function mustNotRun(what: string) {
    return async (): Promise<never> => {
        throw new Error(`${what} ran`);
    };
}

describe("opening a bundle", () => {
    const brave = defaultRouterConfig({ name: "com.brave.Browser", appType: "bundleId" });
    const pages = [1, 2, 3, 4, 5].map((n) => `https://example.com/page/${n}`);

    test("five pages open in one new browser window, without asking", async () => {
        const calls: string[][] = [];
        const plan = await openBundle(pages, brave, {
            open: async (args) => {
                calls.push(args);
            },
            confirm: mustNotRun("confirm"),
            peek: () => null,
        });

        expect(calls).toEqual([["-n", "-b", "com.brave.Browser", "--args", "--new-window", ...pages]]);
        expect(plan.skipped).toEqual([]);
    });

    test("above the cap it asks, and a refusal opens nothing", async () => {
        const many = Array.from({ length: TAB_CAP + 1 }, (_, n) => `https://example.com/p/${n}`);
        const asked: string[] = [];

        await expect(
            openBundle(many, brave, {
                open: mustNotRun("open"),
                confirm: async (message) => {
                    asked.push(message);
                    return false;
                },
                peek: () => null,
            })
        ).rejects.toThrow(`${TAB_CAP + 1} tabs were not opened`);
        expect(asked).toEqual([`Open ${TAB_CAP + 1} tabs?`]);

        const opened: string[][] = [];
        await openBundle(many, brave, {
            open: async (args) => {
                opened.push(args);
            },
            confirm: async () => true,
            peek: () => null,
        });
        expect(opened[0]?.slice(5)).toEqual(many);
    });

    test("a bundle link inside a bundle is skipped, so a bundle that contains itself cannot loop", async () => {
        const calls: string[][] = [];
        const plan = await openBundle(
            [
                "https://genesis.tools/tabs/morning",
                "http://127.0.0.1:6666/tabs/morning",
                "https://genesis.tools/t/bundletoken1",
                "https://example.com/a",
            ],
            brave,
            {
                open: async (args) => {
                    calls.push(args);
                },
                confirm: mustNotRun("confirm"),
                peek: (id) =>
                    id === "bundletoken1"
                        ? { url: "https://example.com/a", usesLeft: 1, urls: ["https://example.com/a"] }
                        : null,
            }
        );

        expect(plan.skipped.map((item) => item.url)).toEqual([
            "https://genesis.tools/tabs/morning",
            "http://127.0.0.1:6666/tabs/morning",
            "https://genesis.tools/t/bundletoken1",
        ]);
        expect(calls).toEqual([["-n", "-b", "com.brave.Browser", "--args", "--new-window", "https://example.com/a"]]);
    });

    test("a link with its own route goes to GenesisTools.app, which routes it as a click", async () => {
        const calls: string[][] = [];
        await openBundle(["https://genesis.tools/done/7", "https://example.com/a"], mintedConfig(), {
            open: async (args) => {
                calls.push(args);
            },
            confirm: mustNotRun("confirm"),
            peek: () => null,
        });

        expect(calls).toEqual([
            ["-a", "Safari", "https://example.com/a"],
            ["-b", "com.genesiscz.genesistools", "https://genesis.tools/done/7"],
        ]);
    });
});

describe("bundle tokens", () => {
    const urls = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];

    function recorder() {
        const opened: string[][] = [];
        const deps = {
            open: async (args: string[]) => {
                opened.push(args);
            },
            confirm: async () => true,
        };
        return { opened, deps };
    }

    test("one click spends one use and opens every link; an old single-link record still redeems", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const id = await withTokenLock(() => mintBundleToken(urls, 2));
            const { opened, deps } = recorder();

            expect(route(tokenLink(id), mintedConfig())).toMatchObject({
                kind: "run",
                argv: ["tools", "browser-router", "token", "open", id],
                needsApproval: false,
            });
            // Redeeming a bundle only peeks: the use is spent when it opens.
            expect(await redeemMintedLink(id, mintedConfig())).toEqual({ kind: "bundle", urls });
            expect(takeToken(id, false)?.usesLeft).toBe(2);

            await openMintedLink(id, mintedConfig(), deps);
            expect(takeToken(id, false)?.usesLeft).toBe(1);
            await openMintedLink(id, mintedConfig(), deps);
            await expect(openMintedLink(id, mintedConfig(), deps)).rejects.toThrow("link used up");
            expect(opened).toEqual([
                ["-a", "Safari", ...urls],
                ["-a", "Safari", ...urls],
            ]);

            writeFileSync(
                tokenFile(),
                `${SafeJSON.stringify({ legacy1: { url: "https://genesis.tools/done/3", usesLeft: 1 } })}\n`
            );
            const legacy = await redeemMintedLink("legacy1", mintedConfig());
            expect(legacy.kind === "perform" && legacy.decision.kind === "run" ? legacy.decision.argv : []).toEqual([
                "/usr/bin/true",
                "3",
            ]);
        });
    });

    test("a cancelled confirmation keeps the use, so the same link opens on the next click", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const many = Array.from({ length: TAB_CAP + 1 }, (_, n) => `https://example.com/p/${n}`);
            const id = await withTokenLock(() => mintBundleToken(many, 1));

            await expect(
                openMintedLink(id, mintedConfig(), { open: mustNotRun("open"), confirm: async () => false })
            ).rejects.toThrow(`${TAB_CAP + 1} tabs were not opened`);
            expect(takeToken(id, false)?.usesLeft).toBe(1);

            const { opened, deps } = recorder();
            await openMintedLink(id, mintedConfig(), deps);
            expect(opened).toEqual([["-a", "Safari", ...many]]);
            expect(takeToken(id, false)).toBeNull();
        });
    });

    test("two clicks at once on a one-use bundle open it once", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const id = await withTokenLock(() => mintBundleToken(urls, 1));
            const { opened, deps } = recorder();
            const results = await Promise.allSettled([
                openMintedLink(id, mintedConfig(), deps),
                openMintedLink(id, mintedConfig(), deps),
            ]);

            expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
            expect(opened).toHaveLength(1);
        });
    });

    test("the consuming route of `open` leaves a bundle's use to `token open`, so a one-use bundle opens once", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const id = await withTokenLock(() => mintBundleToken(urls, 1));

            // What `openUrl` does before it runs the decision: route under the lock, consuming.
            const decision = await withTokenLock(() => route(tokenLink(id), mintedConfig(), true, true));
            expect(decision).toMatchObject({ kind: "run", argv: ["tools", "browser-router", "token", "open", id] });
            expect(takeToken(id, false)?.usesLeft).toBe(1);

            const { opened, deps } = recorder();
            await openMintedLink(id, mintedConfig(), deps);
            expect(opened).toEqual([["-a", "Safari", ...urls]]);
            expect(takeToken(id, false)).toBeNull();

            // Negative control: the consuming route still spends a single-link token.
            const single = await mint("https://genesis.tools/done/5", 1);
            await withTokenLock(() => route(tokenLink(single), mintedConfig(), true, true));
            expect(takeToken(single, false)).toBeNull();
        });
    });
});

describe("runChecked", () => {
    test("a command that writes more than a pipe holds still finishes, and a failure carries its stderr", async () => {
        await runChecked(["/bin/sh", "-c", "head -c 262144 /dev/zero; head -c 262144 /dev/zero >&2"], "command");

        await expect(runChecked(["/bin/sh", "-c", "echo broken >&2; exit 3"], "command")).rejects.toThrow("broken");
    });
});

describe("preset drift fix", () => {
    test("the fix status prints clears the drift: a changed action and a pattern the preset dropped", async () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const own = presetById("decide", () => true)?.routes[0];

            if (own?.action.type !== "run") {
                throw new Error("decide ships one run route");
            }

            const changed = { ...own, action: { ...own.action, notify: "an older notify" } };
            const dropped = { ...own, pattern: "https?://genesis\\.tools/answer/([a-z0-9-]+)/(\\d+)/([a-z])" };
            await saveConfig({ ...defaultRouterConfig("Safari"), routes: [dropped, changed] });
            const before = routerStatus({ check: () => true, config: await loadConfig(), handler: null });
            const row = before.presets.find((item) => item.id === "decide");

            expect(row?.drift).toEqual([
                "Answer a decision: action differs from the preset",
                `${dropped.pattern}: no longer in the preset`,
            ]);
            expect(row?.fix).toBe("tools browser-router presets enable decide");

            await enablePreset("decide", () => true);
            const after = routerStatus({ check: () => true, config: await loadConfig(), handler: null });

            expect(after.presets.find((item) => item.id === "decide")?.drift).toEqual([]);
            expect((await loadConfig())?.routes.filter((rule) => rule.preset === "decide")).toEqual([own]);
        });
    });

    test("a preset that is not available names what it needs instead of a fix that refuses", () => {
        const own = presetById("cmux-claude", () => true)?.routes[0];

        if (own?.action.type !== "run") {
            throw new Error("cmux-claude ships one run route");
        }

        const drifted = { ...own, action: { ...own.action, argv: own.action.argv.slice(0, 4) } };
        const status = routerStatus({
            check: (capability) => capability !== "cmux:installed",
            config: { ...defaultRouterConfig(), routes: [drifted] },
            handler: null,
        });
        const row = status.presets.find((item) => item.id === "cmux-claude");

        expect(row?.drift).toEqual(["Run Claude in cmux: action differs from the preset"]);
        expect(row?.fix).toBeUndefined();
        expect(row?.missing).toEqual(["cmux:installed"]);
    });
});
