import { describe, expect, test } from "bun:test";
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

const config = defaultRouterConfig();

describe("route", () => {
    test("localhost:6666 becomes a genesis-md open", () => {
        const decision = route("https://localhost:6666/open?path=%2Ftmp%2Fa%20b.md", config);

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

    test("127.0.0.1 uses the same rule", () => {
        const decision = route("http://127.0.0.1:6666/panel/chat", config);

        expect(decision.url).toBe("genesis-md://panel/chat");
    });

    test("a pattern does not match when the URL merely contains it", () => {
        const decision = route("https://evil.test/?next=https://localhost:6666/open", config);

        expect(decision.kind).toBe("forward");
        expect(decision.url).toBe("https://evil.test/?next=https://localhost:6666/open");
    });

    test("a registered local port is started before the page opens", () => {
        const custom = { ...config, services: [{ port: 3999, name: "Example" }] };
        const decision = route("http://127.0.0.1:3999/x", custom);
        expect(decision).toMatchObject({
            kind: "run",
            argv: ["tools", "browser-router", "ensure", "3999"],
            notify: "Starting Example",
            open: "http://127.0.0.1:3999/x",
            approval: "allow",
            needsApproval: false,
        });
        expect(route("http://localhost:3999/", custom).kind).toBe("run");
    });

    test("an unregistered port and the router's own 6666 keep today's routing", () => {
        const custom = {
            ...config,
            services: [
                { port: 3999, name: "Example" },
                { port: 6666, name: "Router" },
            ],
        };

        expect(route("http://127.0.0.1:4555/x", custom)).toMatchObject({ kind: "forward", via: "default" });
        expect(route("http://127.0.0.1:6666/panel/chat", custom)).toMatchObject({
            kind: "open",
            url: "genesis-md://panel/chat",
        });
        // A saved route still wins over the registry: routes and aliases come first.
        const routed = {
            ...custom,
            routes: [
                {
                    pattern: "https?://127\\.0\\.0\\.1:3999/special",
                    action: { type: "open" as const, to: "genesis-md://x" },
                },
                ...custom.routes,
            ],
        };
        expect(route("http://127.0.0.1:3999/special", routed).kind).toBe("open");
        expect(route("https://example.com:3999/x", custom).kind).toBe("forward");
    });

    test("a raw cmux launch asks and names the prompt; a minted one does not", () => {
        const custom: RouterConfig = {
            ...config,
            routes: [
                {
                    pattern: "https?://genesis\\.tools/cmux/claude/run",
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
            "https://genesis.tools/cmux/claude/run?account=work&prompt=do%20it&cwd=%2Ftmp&resume=abc&name=h&model=opus&surface=split&arg=--permission-mode&arg=plan";
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

    test("the user's genesis.tools pattern keeps only the capture", () => {
        const custom: RouterConfig = {
            defaultBrowser: "com.brave.Browser",
            routes: [
                {
                    pattern: "https?://genesis.tools/open-genesis/(.*)",
                    action: { type: "open", to: "genesis-md://$1" },
                },
            ],
        };
        const decision = route("https://genesis.tools/open-genesis/open?path=%2Ftmp%2Fa.md", custom);

        expect(decision.url).toBe("genesis-md://open?path=%2Ftmp%2Fa.md");
    });

    test("a tool route is recorded and still needs approval", () => {
        const custom: RouterConfig = {
            defaultBrowser: "Safari",
            routes: [
                {
                    pattern: "https://genesis.tools/run/([a-z0-9-]+)/(.*)",
                    action: { type: "tool", tool: "mail", args: ["$1", "$2"], approval: "ask" },
                },
            ],
        };
        const decision = route("https://genesis.tools/run/search/inbox", custom);

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

    test("genesis.tools is an alias of the local router when aliases are allowed", () => {
        const decision = route("https://genesis.tools/open?path=/tmp/a.md", config);
        expect(decision.url).toBe("genesis-md://open?path=/tmp/a.md");

        const blocked = route("https://genesis.tools/open?path=/tmp/a.md", { ...config, allowAliases: false });
        expect(blocked.kind).toBe("forward");
        expect(blocked.url).toBe("https://genesis.tools/open?path=/tmp/a.md");
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
        const wrapped = `https://127.0.0.1:6666/link/${encodeURIComponent("genesis-md://open?path=/tmp/a.md")}`;
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
        const expression = compileRoutePattern("https?://genesis.tools/open-genesis/(.*)");

        expect(expression.source.startsWith("^")).toBe(true);
        expect(expression.source.endsWith("$")).toBe(true);
    });
});

describe("built-in routes", () => {
    test("the tabs link that `tabs save` prints runs `tabs open`", () => {
        const decision = route("https://genesis.tools/tabs/morning", config);

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
            const wrapped = `https://genesis.tools/link/${encodeURIComponent(inner)}`;
            expect(() => route(wrapped, config)).toThrow("only http(s) and genesis-md links are unwrapped");
        }

        const md = `https://genesis.tools/link/${encodeURIComponent("genesis-md://open?path=/tmp/a.md")}`;
        expect(route(md, config).url).toBe("genesis-md://open?path=/tmp/a.md");
    });
});
