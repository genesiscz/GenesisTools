import { describe, expect, test } from "bun:test";
import { getDashboard } from "@genesiscz/utils/ui/dashboards";
import { applyPresets, presets } from "./presets";
import {
    compileRoutePattern,
    compileUrlTemplate,
    defaultRouterConfig,
    parseConfig,
    RouteError,
    type RouterConfig,
    route,
    substitute,
} from "./route";
import { browserHosts } from "./services";

const LINK_HOST = "links.example.test";

/** A config as `ensureBuiltinRoutes` would write it: the presets' routes on the invented link host. */
function withPresets(chosen: RouterConfig["presets"]): RouterConfig {
    const base: RouterConfig = { ...defaultRouterConfig(), linkHost: LINK_HOST, presets: chosen };
    return { ...base, routes: applyPresets([], presets({ config: base, check: () => true })) };
}

const config = withPresets({ "genesis-md": {} });

describe("route", () => {
    test("/md/ on the link host becomes a genesis-md open", () => {
        const decision = route("https://links.example.test/md/open?path=%2Ftmp%2Fa%20b.md", config);

        expect(decision.kind).toBe("open");
        expect(decision.url).toBe("genesis-md://open?path=%2Ftmp%2Fa%20b.md");

        if (decision.kind !== "open") {
            return;
        }

        expect(decision.openArguments).toEqual([
            "-b",
            "dev.foltyn.genesis.markdown",
            "genesis-md://open?path=%2Ftmp%2Fa%20b.md",
        ]);
        expect(decision.browser?.name).toBe("dev.foltyn.genesis.markdown");
        expect(decision.via).toBe("route");
    });

    test("http on the link host uses the same rule", () => {
        const decision = route("http://links.example.test/md/panel/chat", config);

        expect(decision.url).toBe("genesis-md://panel/chat");
    });

    test("a pattern does not match when the URL merely contains it", () => {
        const decision = route("https://evil.test/?next=https://links.example.test/md/open", config);

        expect(decision.kind).toBe("forward");
        expect(decision.url).toBe("https://evil.test/?next=https://links.example.test/md/open");
    });

    test("no preset is on by default, and without a link host nothing is routed", () => {
        const bare = defaultRouterConfig();
        const all = presets({ config: bare, check: () => true });

        expect(bare.routes).toEqual([]);
        expect(all.filter((preset) => preset.enabled)).toEqual([]);
        expect(all.find((preset) => preset.id === "core")?.missing).toEqual([
            "a link host (tools browser-router link-host <host>)",
        ]);
        expect(route("http://localhost:3000/", bare)).toMatchObject({ kind: "forward", via: "default" });
        expect(route("https://dashboard/", bare)).toMatchObject({ kind: "forward", via: "default" });
    });

    test("local-services starts a registered port before the page opens", () => {
        const dashboard = getDashboard("personal-dashboard");
        const custom = withPresets({ "local-services": {} });

        expect(route(`http://127.0.0.1:${dashboard.port}/x?y=1`, custom)).toMatchObject({
            kind: "run",
            argv: ["tools", "browser-router", "ensure", String(dashboard.port)],
            notify: `Starting ${dashboard.name}`,
            open: `http://localhost:${dashboard.port}/x?y=1`,
            approval: "allow",
            needsApproval: false,
            service: { port: dashboard.port, name: dashboard.name },
        });
        expect(route("http://127.0.0.1:4555/x", custom)).toMatchObject({ kind: "forward", via: "default" });
    });

    test("dashboard-names: a registry key as a host and as a path on the link host", () => {
        const dashboard = getDashboard("dev-dashboard");
        const custom = withPresets({ "dashboard-names": {} });
        const opened = `http://localhost:${dashboard.port}/tasks?x=1#top`;

        expect(route("https://dev-dashboard/tasks?x=1#top", custom)).toMatchObject({ kind: "run", open: opened });
        expect(route("https://links.example.test/dev-dashboard/tasks?x=1#top", custom)).toMatchObject({
            kind: "run",
            open: opened,
        });
        expect(route("http://DEV-DASHBOARD", custom)).toMatchObject({ open: `http://localhost:${dashboard.port}/` });
        // Only the exact name, without a port of its own.
        expect(route("https://dev-dashboardxyz/", custom)).toMatchObject({ kind: "forward", via: "default" });
        expect(route("http://dev-dashboard:8080/", custom)).toMatchObject({ kind: "forward", via: "default" });
        // `only` narrows the names.
        const narrowed = withPresets({ "dashboard-names": { only: ["jev"] } });
        expect(route("https://dev-dashboard/", narrowed)).toMatchObject({ kind: "forward", via: "default" });
        expect(browserHosts(narrowed).hosts).toEqual(["jev"]);
    });

    test("a names entry gives a registry dashboard an extra name, as a host and as a path", () => {
        const library = getDashboard("artifact-library");
        const custom = withPresets({ "dashboard-names": { names: { dashboard: "artifact-library" } } });

        expect(route("https://dashboard/x", custom)).toMatchObject({ open: `http://localhost:${library.port}/x` });
        expect(route("https://links.example.test/dashboard/", custom)).toMatchObject({
            open: `http://localhost:${library.port}/`,
        });
        expect(browserHosts(custom).hosts).toContain("dashboard");
        expect(() =>
            parseConfig({ defaultBrowser: "Safari", presets: { "dashboard-names": { names: { "bad host": "x" } } } })
        ).toThrow("host name");
    });

    test("the artifact preset's /artifact/<name>/ links are not shadowed by the artifact dashboard's name", () => {
        const custom = withPresets({ artifact: {}, "dashboard-names": {} });

        expect(route("https://links.example.test/artifact/notes/index.html", custom)).toMatchObject({
            kind: "run",
            argv: expect.arrayContaining(["artifact", "open", "--", "notes", "index.html"]),
        });
    });

    test("an alias renames the host first, so it wins over the name's own route", () => {
        const library = getDashboard("artifact-library");
        const custom = {
            ...withPresets({ "local-services": {}, "dashboard-names": {} }),
            aliases: [{ host: "dashboard", base: `http://localhost:${library.port}` }],
        };

        expect(route("https://dashboard/a/x?y=1", custom)).toMatchObject({
            kind: "run",
            argv: ["tools", "browser-router", "ensure", String(library.port)],
            open: `http://localhost:${library.port}/a/x?y=1`,
        });
        expect(browserHosts(custom).hosts).toContain("dashboard");
        // A saved route of the user's own still wins over a preset for the same URL.
        const own = {
            ...custom,
            routes: applyPresets(
                [{ pattern: "https?://jev/special", action: { type: "open" as const, to: "genesis-md://x" } }],
                presets({ config: custom, check: () => true })
            ),
        };
        expect(route("https://jev/special", own).kind).toBe("open");
    });

    test("a raw cmux launch asks and names the prompt; a minted one does not", () => {
        const custom: RouterConfig = {
            ...config,
            routes: [
                {
                    pattern: "https?://links\\.example\\.test/cmux/claude/run",
                    action: {
                        type: "run",
                        argv: ["tools", "cmux", "launch", "--account", "{account}", "--prompt", "{prompt}"],
                        approval: "ask",
                        trustMinted: true,
                    },
                },
                ...config.routes,
            ],
        };
        const url =
            "https://links.example.test/cmux/claude/run?account=work&prompt=do%20it&cwd=%2Ftmp&resume=abc&name=h&model=opus&surface=split&arg=--permission-mode&arg=plan";
        const raw = route(url, custom);

        expect(raw.kind).toBe("run");

        if (raw.kind !== "run") {
            return;
        }

        expect(raw.needsApproval).toBe(true);
        expect(raw.launch).toEqual({
            agent: "claude",
            account: "work",
            prompt: "do it",
            cwd: "/tmp",
            resume: "abc",
            name: "h",
            model: "opus",
            surface: "split",
            extra: ["--permission-mode", "plan"],
            runArgs: [],
        });
        expect(raw.argv.slice(-2)).toEqual(["--claude-arg=--permission-mode", "--claude-arg=plan"]);

        const minted = route(url, custom, true, false, true);

        if (minted.kind !== "run") {
            throw new Error("expected a run");
        }

        expect(minted.needsApproval).toBe(false);
        const huge = new URL(url);
        huge.searchParams.set("prompt", "x".repeat(9000));
        expect(() => route(huge.href, custom)).toThrow(RouteError);
    });

    test("an unmatched https URL goes to the default browser", () => {
        const decision = route("https://example.com/a", config);

        expect(decision.kind).toBe("forward");

        if (decision.kind !== "forward") {
            return;
        }

        expect(decision.browser?.name).toBe("com.brave.Browser");
        expect(decision.openArguments).toEqual(["-b", "com.brave.Browser", "https://example.com/a"]);
        expect(decision.via).toBe("default");
    });

    test("an http rewrite is not opened back into this app", () => {
        const looping: RouterConfig = {
            defaultBrowser: { name: "com.brave.Browser", appType: "bundleId" },
            routes: [{ pattern: "https://example.com/(.*)", action: { type: "open", to: "https://other.test/$1" } }],
        };
        const decision = route("https://example.com/x", looping);

        expect(decision.kind).toBe("forward");
        expect(decision.url).toBe("https://other.test/x");
        expect(decision.via).toBe("loop-guard");
    });

    test("the user's links.example.test pattern keeps only the capture", () => {
        const custom: RouterConfig = {
            defaultBrowser: "com.brave.Browser",
            routes: [
                {
                    pattern: "https?://links.example.test/open-genesis/(.*)",
                    action: { type: "open", to: "genesis-md://$1" },
                },
            ],
        };
        const decision = route("https://links.example.test/open-genesis/open?path=%2Ftmp%2Fa.md", custom);

        expect(decision.url).toBe("genesis-md://open?path=%2Ftmp%2Fa.md");
    });

    test("a tool route is recorded and still needs approval", () => {
        const custom: RouterConfig = {
            defaultBrowser: "Safari",
            routes: [
                {
                    pattern: "https://links.example.test/run/([a-z0-9-]+)/(.*)",
                    action: { type: "tool", tool: "mail", args: ["$1", "$2"], approval: "ask" },
                },
            ],
        };
        const decision = route("https://links.example.test/run/search/inbox", custom);

        expect(decision).toMatchObject({
            kind: "tool",
            tool: "mail",
            args: ["search", "inbox"],
            approval: "ask",
            needsApproval: true,
        });
    });

    test("the first matching route wins", () => {
        const custom: RouterConfig = {
            defaultBrowser: "Safari",
            routes: [
                { pattern: "https://example.com/.*", action: { type: "open", to: "genesis-md://first" } },
                { pattern: "https://example.com/second", action: { type: "open", to: "genesis-md://second" } },
            ],
        };

        expect(route("https://example.com/second", custom).url).toBe("genesis-md://first");
    });

    test("an alias rewrites the host onto its base, unless aliases are off", () => {
        const aliased = { ...config, aliases: [{ host: "notes.example.test", base: "https://links.example.test/md" }] };
        expect(route("https://notes.example.test/open?path=/tmp/a.md", aliased).url).toBe(
            "genesis-md://open?path=/tmp/a.md"
        );

        const blocked = route("https://notes.example.test/open?path=/tmp/a.md", { ...aliased, allowAliases: false });
        expect(blocked.kind).toBe("forward");
        expect(blocked.url).toBe("https://notes.example.test/open?path=/tmp/a.md");
    });

    test("a :name template compiles without a handwritten regular expression", () => {
        const compiled = compileUrlTemplate("http://127.0.0.1:8787/add/:id?qty=:qty");
        expect(compiled?.names).toEqual(["id", "qty"]);
        const custom: RouterConfig = {
            defaultBrowser: "com.brave.Browser",
            routes: [
                {
                    pattern: compiled!.pattern,
                    action: {
                        type: "run",
                        argv: ["bun", "rohlik.ts", "add", "$1", "--qty", "$2"],
                        approval: "allow",
                        touchId: true,
                    },
                },
            ],
        };
        const decision = route("http://127.0.0.1:8787/add/1472972?qty=2", custom);
        expect(decision).toMatchObject({
            kind: "run",
            argv: ["bun", "rohlik.ts", "add", "1472972", "--qty", "2"],
            touchId: true,
            needsApproval: false,
        });
    });

    test("a wrapped genesis-md link opens Genesis Markdown", () => {
        const wrapped = `https://links.example.test/link/${encodeURIComponent("genesis-md://open?path=/tmp/a.md")}`;
        const decision = route(wrapped, config);

        expect(decision.kind).toBe("open");
        expect(decision.url).toBe("genesis-md://open?path=/tmp/a.md");
    });

    test("a run route fills captures, query values, and comma splits", () => {
        const custom: RouterConfig = {
            defaultBrowser: "com.brave.Browser",
            routes: [
                {
                    pattern: "https?://127\\.0\\.0\\.1:8787/add/(\\d+)",
                    action: {
                        type: "run",
                        argv: ["bun", "rohlik.ts", "add", "$1", "--qty", "{qty}"],
                        approval: "allow",
                        notify: "Added ×{qty}",
                    },
                },
                {
                    pattern: "https?://127\\.0\\.0\\.1:8787/add-many",
                    action: {
                        type: "run",
                        argv: ["bun", "rohlik.ts", "add", "{ids*}", "--qty", "{qty}"],
                        approval: "ask",
                    },
                },
            ],
        };
        const one = route("http://127.0.0.1:8787/add/1472972?qty=1", custom);
        expect(one).toMatchObject({
            kind: "run",
            argv: ["bun", "rohlik.ts", "add", "1472972", "--qty", "1"],
            notify: "Added ×1",
            needsApproval: false,
        });
        const many = route("http://127.0.0.1:8787/add-many?ids=1,2&qty=1", custom);
        expect(many).toMatchObject({
            kind: "run",
            argv: ["bun", "rohlik.ts", "add", "1", "2", "--qty", "1"],
            needsApproval: true,
        });
    });

    test("$$ stays a dollar and a missing group is empty", () => {
        expect(substitute("genesis-md://$1$$", ["whole", "open"] as unknown as RegExpExecArray)).toBe(
            "genesis-md://open$"
        );
    });

    test("a route toast overrides the card and false turns it off", () => {
        const parsed = parseConfig({
            defaultBrowser: "Safari",
            toast: { enabled: true, seconds: 5 },
            routes: [
                {
                    pattern: "https://example.com/.*",
                    toast: { title: "Opening mail", seconds: 2 },
                    action: { type: "open", to: "genesis-md://$1" },
                },
                {
                    pattern: "https://example.com/quiet",
                    toast: false,
                    action: { type: "open", to: "genesis-md://quiet" },
                },
            ],
        });

        expect(parsed.toast).toEqual({ enabled: true, seconds: 5 });
        expect(parsed.routes[0]?.toast).toEqual({ title: "Opening mail", seconds: 2 });
        expect(parsed.routes[1]?.toast).toBe(false);
    });

    test("a route keeps its name, trimmed, and a blank name is dropped", () => {
        const parsed = parseConfig({
            defaultBrowser: "Safari",
            routes: [
                { pattern: "https://a.test/(.*)", name: "  Open mail ", action: { type: "open", to: "x" } },
                { pattern: "https://b.test/(.*)", name: " ", action: { type: "open", to: "x" } },
            ],
        });

        expect(parsed.routes[0]?.name).toBe("Open mail");
        expect(parsed.routes[1] && "name" in parsed.routes[1]).toBe(false);
    });

    test("a bad pattern is rejected at config parse", () => {
        expect(() =>
            parseConfig({ defaultBrowser: "Safari", routes: [{ pattern: "(", action: { type: "open", to: "x" } }] })
        ).toThrow(RouteError);
    });

    test("anchors a pattern that the user wrote without them", () => {
        const expression = compileRoutePattern("https?://links.example.test/open-genesis/(.*)");

        expect(expression.source.startsWith("^")).toBe(true);
        expect(expression.source.endsWith("$")).toBe(true);
    });
});

describe("built-in routes", () => {
    test("the tabs link that `tabs save` prints runs `tabs open`", () => {
        const decision = route("https://links.example.test/tabs/morning", config);

        expect(decision.kind).toBe("run");
        expect(decision.kind === "run" ? decision.argv : []).toEqual([
            "tools",
            "browser-router",
            "tabs",
            "open",
            "morning",
        ]);
        expect(decision.kind === "run" ? decision.needsApproval : true).toBe(false);
    });

    test("a wrapped link opens only http(s) and genesis-md, never another scheme handler", () => {
        for (const inner of ["file:///tmp/x.command", "x-apple.systempreferences:com.apple.preference.security"]) {
            const wrapped = `https://links.example.test/link/${encodeURIComponent(inner)}`;
            expect(() => route(wrapped, config)).toThrow("only http(s) and genesis-md links are unwrapped");
        }

        const md = `https://links.example.test/link/${encodeURIComponent("genesis-md://open?path=/tmp/a.md")}`;
        expect(route(md, config).url).toBe("genesis-md://open?path=/tmp/a.md");
    });
});
