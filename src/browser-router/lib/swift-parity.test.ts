import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetById } from "@genesiscz/utils/browser-router/presets";
import { defaultRouterConfig, parseConfig, type RouteDecision, route } from "@genesiscz/utils/browser-router/route";
import { CLEAN_CASES } from "@genesiscz/utils/browser-router/testing/clean-cases";
import { SafeJSON } from "@genesiscz/utils/json";

// The router ships in a macOS app. swiftc on Linux is not its toolchain, and its compile outlives the
// default 5 s test timeout on a CI runner.
const swiftc =
    process.platform === "darwin" ? spawnSync("swiftc", ["--version"], { encoding: "utf8", env: process.env }) : null;
const canCompile = swiftc?.status === 0;

describe.skipIf(!canCompile)("swift router parity", () => {
    test("the helper agrees with the TypeScript router", () => {
        const home = mkdtempSync(join(tmpdir(), "browser-router-swift-"));
        const configPath = join(home, "config.json");
        const binary = join(home, "router-cli");
        const parityConfig = { ...defaultRouterConfig(), services: [{ port: 3999, name: "Example" }] };
        writeFileSync(configPath, `${SafeJSON.stringify(parityConfig, null, 2)}\n`);
        const compiled = spawnSync(
            "swiftc",
            [
                "-o",
                binary,
                join(import.meta.dir, "../native/Router.swift"),
                join(import.meta.dir, "../native/Cli.swift"),
            ],
            { encoding: "utf8", env: process.env }
        );

        expect(compiled.status, compiled.stderr).toBe(0);
        const samples = [
            "https://example.com/a",
            "https://localhost:6666/open?path=%2Ftmp%2Fa%20b.md",
            "http://127.0.0.1:6666/panel/chat",
            "http://127.0.0.1:3999/x",
            "https://example.com/a?utm_source=newsletter",
            `https://127.0.0.1:6666/link/${encodeURIComponent("genesis-md://open?path=/tmp/a.md")}`,
            "https://genesis.tools/tabs/morning",
            `https://nam.safelinks.protection.outlook.com/x?url=${encodeURIComponent(
                `https://www.google.com/url?q=${encodeURIComponent("https://shop.example/item?id=1")}`
            )}`,
            // An unregistered local port keeps today's routing; only a registered one is started.
            "http://127.0.0.1:4555/x",
            "http://localhost:3999/",
            // One sample per link-cleaner rule.
            ...CLEAN_CASES.map((row) => row.input),
        ];

        for (const sample of samples) {
            const expected = route(sample, parityConfig);
            const ran = spawnSync(binary, [configPath, sample], { encoding: "utf8", env: process.env });
            expect(ran.status, ran.stderr).toBe(0);
            const actual = SafeJSON.parse(ran.stdout, { strict: true }) as RouteDecision;
            expect(actual.kind).toBe(expected.kind);
            expect(actual.url).toBe(expected.url);
            expect(actual.via).toBe(expected.via);
            expect("openArguments" in actual ? actual.openArguments : []).toEqual(
                expected.kind === "tool" || expected.kind === "run" ? [] : expected.openArguments
            );
            if (expected.kind === "run" && actual.kind === "run") {
                expect(actual.argv).toEqual(expected.argv);
            }
        }

        // Alias settings: `allowAliases: false` turns the default genesis.tools alias off, and a custom
        // alias list replaces it.
        const aliasConfigs = {
            off: { ...defaultRouterConfig(), allowAliases: false },
            custom: {
                ...defaultRouterConfig(),
                aliases: [{ host: "links.example.test", base: "https://127.0.0.1:6666" }],
            },
        };
        const aliasSamples = ["https://genesis.tools/panel/chat", "https://links.example.test/panel/chat"];

        for (const [name, config] of Object.entries(aliasConfigs)) {
            const path = join(home, `alias-${name}.json`);
            writeFileSync(path, `${SafeJSON.stringify(config, null, 2)}\n`);

            for (const sample of aliasSamples) {
                const expected = route(sample, config);
                const ran = spawnSync(binary, [path, sample], { encoding: "utf8", env: process.env });
                expect(ran.status, ran.stderr).toBe(0);
                const actual = SafeJSON.parse(ran.stdout, { strict: true }) as RouteDecision;
                expect({ name, sample, kind: actual.kind, url: actual.url, via: actual.via }).toEqual({
                    name,
                    sample,
                    kind: expected.kind,
                    url: expected.url,
                    via: expected.via,
                });
            }
        }

        expect(route("https://links.example.test/panel/chat", aliasConfigs.custom).url).toBe("genesis-md://panel/chat");
        expect(route("https://genesis.tools/panel/chat", aliasConfigs.off).via).toBe("default");

        // An alias whose base is not an absolute URL fails in both routers instead of being ignored.
        const badAlias = { ...defaultRouterConfig(), aliases: [{ host: "genesis.tools", base: "not-a-url" }] };
        const badAliasPath = join(home, "alias-bad.json");
        writeFileSync(badAliasPath, `${SafeJSON.stringify(badAlias, null, 2)}\n`);
        expect(() => route("https://genesis.tools/panel/chat", badAlias)).toThrow();
        const badRun = spawnSync(binary, [badAliasPath, "https://genesis.tools/panel/chat"], {
            encoding: "utf8",
            env: process.env,
        });
        expect(badRun.status).toBe(1);
        expect(badRun.stderr).toContain("is not an absolute URL");

        // A route this build cannot parse is skipped, not fatal: the next route still runs, with its
        // own index in the config.
        const skipConfig = {
            defaultBrowser: "Safari",
            routes: [
                { pattern: "https?://genesis\\.tools/new/(\\d+)", action: { type: "from-the-future" } },
                {
                    pattern: "https?://genesis\\.tools/mail/show/(\\d+)",
                    action: { type: "run", argv: ["/usr/bin/true", "$1"], approval: "allow" },
                },
            ],
        };
        const skipPath = join(home, "skip.json");
        writeFileSync(skipPath, `${SafeJSON.stringify(skipConfig, null, 2)}\n`);
        const skipped = spawnSync(binary, [skipPath, "https://genesis.tools/mail/show/42"], {
            encoding: "utf8",
            env: process.env,
        });
        expect(skipped.status, skipped.stderr).toBe(0);
        expect(skipped.stderr).toContain("router: skipped");
        const skippedDecision = SafeJSON.parse(skipped.stdout, { strict: true }) as Extract<
            RouteDecision,
            { kind: "run" }
        >;
        expect(skippedDecision.kind).toBe("run");
        expect(skippedDecision.argv).toEqual(["/usr/bin/true", "42"]);
        expect(skippedDecision.routeIndex).toBe(1);

        // A wrapped link to another scheme is refused by both routers.
        const fileLink = `https://genesis.tools/link/${encodeURIComponent("file:///tmp/x.command")}`;
        expect(() => route(fileLink, parityConfig)).toThrow("only http(s) and genesis-md");
        const refused = spawnSync(binary, [configPath, fileLink], { encoding: "utf8", env: process.env });
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("only http(s) and genesis-md");

        // A cmux launch link that carries a prompt asks even on an allow route, and its extra arguments
        // reach the argv, in both routers.
        const launchConfig = {
            ...defaultRouterConfig(),
            routes: [
                {
                    pattern: "https?://genesis\\.tools/cmux/claude/run",
                    action: {
                        type: "run",
                        argv: ["tools", "cmux", "launch", "--prompt", "{prompt}"],
                        approval: "allow",
                    },
                },
            ],
        };
        const launchPath = join(home, "launch.json");
        writeFileSync(launchPath, `${SafeJSON.stringify(launchConfig, null, 2)}\n`);

        for (const sample of [
            "https://genesis.tools/cmux/claude/run?prompt=hello&arg=--verbose&run=make",
            "https://genesis.tools/cmux/claude/run?arg=--verbose",
        ]) {
            const expected = route(sample, parseConfig(launchConfig));
            const ran = spawnSync(binary, [launchPath, sample], { encoding: "utf8", env: process.env });
            expect(ran.status, ran.stderr).toBe(0);
            const actual = SafeJSON.parse(ran.stdout, { strict: true }) as RouteDecision;
            expect(expected.kind).toBe("run");
            expect(
                actual.kind === "run" && expected.kind === "run" ? [actual.argv, actual.needsApproval] : null
            ).toEqual(expected.kind === "run" ? [expected.argv, expected.needsApproval] : null);
        }

        expect(route("https://genesis.tools/cmux/claude/run?prompt=hello", parseConfig(launchConfig))).toMatchObject({
            needsApproval: true,
        });

        // The decide preset: a session id, a number and one letter run the fixed command; anything
        // else (extra segments, text in the option) does not match in either router.
        const decideConfig = { ...defaultRouterConfig(), routes: presetById("decide", () => true)?.routes ?? [] };
        const decidePath = join(home, "decide.json");
        writeFileSync(decidePath, `${SafeJSON.stringify(decideConfig, null, 2)}\n`);
        const session = "3f2a9c1e-0000-4000-8000-00000000abcd";

        for (const sample of [
            `https://genesis.tools/decide/${session}/4/b`,
            `https://genesis.tools/decide/${session}/4/b/extra`,
            `https://genesis.tools/decide/${session}/4/bb`,
            `https://genesis.tools/decide/${session}/4/b%20now`,
        ]) {
            const expected = route(sample, parseConfig(decideConfig));
            const ran = spawnSync(binary, [decidePath, sample], { encoding: "utf8", env: process.env });
            expect(ran.status, ran.stderr).toBe(0);
            const actual = SafeJSON.parse(ran.stdout, { strict: true }) as RouteDecision;
            expect({
                sample,
                kind: actual.kind,
                argv: actual.kind === "run" ? actual.argv : null,
                notify: actual.kind === "run" ? actual.notify : null,
            }).toEqual({
                sample,
                kind: expected.kind,
                argv: expected.kind === "run" ? expected.argv : null,
                notify: expected.kind === "run" ? expected.notify : null,
            });
        }

        expect(route(`https://genesis.tools/decide/${session}/4/b`, parseConfig(decideConfig)).kind).toBe("run");

        // A template with an emoji before its placeholders: regex offsets are UTF-16 units, and the
        // Swift substitution once applied them as Character counts.
        const emojiConfig = {
            ...defaultRouterConfig(),
            routes: [
                {
                    pattern: "https?://genesis\\.tools/emoji/(\\d+)",
                    action: {
                        type: "run",
                        argv: ["/usr/bin/true", "📦 $1 👍 {qty}"],
                        approval: "allow",
                        notify: "🎉 Added $1",
                    },
                },
            ],
        };
        const emojiPath = join(home, "emoji.json");
        writeFileSync(emojiPath, `${SafeJSON.stringify(emojiConfig, null, 2)}\n`);
        const emojiSample = "https://genesis.tools/emoji/42?qty=3";
        const emojiExpected = route(emojiSample, parseConfig(emojiConfig));
        const emojiRan = spawnSync(binary, [emojiPath, emojiSample], { encoding: "utf8", env: process.env });
        expect(emojiRan.status, emojiRan.stderr).toBe(0);
        const emojiActual = SafeJSON.parse(emojiRan.stdout, { strict: true }) as RouteDecision;
        expect(emojiExpected.kind === "run" ? [emojiExpected.argv, emojiExpected.notify] : null).toEqual([
            ["/usr/bin/true", "📦 42 👍 3"],
            "🎉 Added 42",
        ]);
        expect(emojiActual.kind === "run" ? [emojiActual.argv, emojiActual.notify] : null).toEqual([
            ["/usr/bin/true", "📦 42 👍 3"],
            "🎉 Added 42",
        ]);

        // A `{name}` placeholder in an open route, and a wrapped link whose inner URL keeps an encoded
        // `&`: both routers must produce the same URL.
        const placeholderConfig = {
            ...defaultRouterConfig(),
            routes: [
                {
                    pattern: "https?://genesis\\.tools/md-open",
                    action: { type: "open", to: "genesis-md://open?path={file}" },
                },
                ...defaultRouterConfig().routes,
            ],
        };
        const placeholderPath = join(home, "placeholder.json");
        writeFileSync(placeholderPath, `${SafeJSON.stringify(placeholderConfig, null, 2)}\n`);

        for (const sample of [
            "https://genesis.tools/md-open?file=/tmp/a.md",
            `https://genesis.tools/link/${encodeURIComponent("https://example.com/?q=a%26b")}`,
        ]) {
            const expected = route(sample, parseConfig(placeholderConfig));
            const ran = spawnSync(binary, [placeholderPath, sample], { encoding: "utf8", env: process.env });
            expect(ran.status, ran.stderr).toBe(0);
            const actual = SafeJSON.parse(ran.stdout, { strict: true }) as RouteDecision;
            expect({ sample, url: actual.url }).toEqual({ sample, url: expected.url });
        }

        expect(route("https://genesis.tools/md-open?file=/tmp/a.md", parseConfig(placeholderConfig)).url).toBe(
            "genesis-md://open?path=/tmp/a.md"
        );

        // A run route's `open` must be an absolute http(s) URL in both routers: `URL(string:)` alone
        // accepted a relative `report.html` that `new URL()` refuses.
        for (const [open, message] of [
            ["report.html", "open target is not a URL"],
            ["file:///tmp/report.html", "open target is not an http(s) URL"],
            ["https://example.com/done", null],
        ] as const) {
            const openConfig = {
                ...defaultRouterConfig(),
                routes: [
                    {
                        pattern: "https?://genesis\\.tools/done/(\\d+)",
                        action: { type: "run", argv: ["/usr/bin/true", "$1"], approval: "allow", open },
                    },
                ],
            };
            const openPath = join(home, "open-target.json");
            writeFileSync(openPath, `${SafeJSON.stringify(openConfig, null, 2)}\n`);
            const sample = "https://genesis.tools/done/1";
            const ran = spawnSync(binary, [openPath, sample], { encoding: "utf8", env: process.env });

            if (message === null) {
                expect(route(sample, parseConfig(openConfig)).kind).toBe("run");
                expect(ran.status, ran.stderr).toBe(0);
                continue;
            }

            expect(() => route(sample, parseConfig(openConfig))).toThrow(message);
            expect({ open, status: ran.status }).toEqual({ open, status: 1 });
            expect(ran.stderr).toContain(message);
        }
    }, 180_000);
});
