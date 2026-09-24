import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage";
import { deleteRoute, loadConfig, routeFromFlags, saveConfig, upsertRoute } from "./config";
import { openUrl, redeemMintedLink, runChecked } from "./launch";
import { tokenLink } from "./links";
import { defaultRouterConfig, type RouterConfig, route } from "./route";
import { bundleUrls, saveBundle } from "./tabs";
import { mintToken, takeToken, tokenFile, withTokenLock } from "./tokens";

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
});

describe("runChecked", () => {
    test("a command that writes more than a pipe holds still finishes, and a failure carries its stderr", async () => {
        await runChecked(["/bin/sh", "-c", "head -c 262144 /dev/zero; head -c 262144 /dev/zero >&2"], "command");

        await expect(runChecked(["/bin/sh", "-c", "echo broken >&2; exit 3"], "command")).rejects.toThrow("broken");
    });
});
