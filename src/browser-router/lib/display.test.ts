import { describe, expect, test } from "bun:test";
import { defaultRouterConfig, type RouteRule } from "@genesiscz/utils/browser-router/route";
import { actionSummary, isEnabled } from "./display";

describe("actionSummary", () => {
    test("open names the target", () => {
        expect(actionSummary({ type: "open", to: "genesis-md://$1" })).toBe("open genesis-md://$1");
    });

    test("forward names the browser, and the target only when the route rewrites it", () => {
        expect(actionSummary({ type: "forward", browser: "com.brave.Browser" })).toBe("forward com.brave.Browser");
        expect(
            actionSummary({
                type: "forward",
                to: "https://example.com/$1",
                browser: { name: "com.apple.Safari", appType: "bundleId" },
            })
        ).toBe("forward com.apple.Safari https://example.com/$1");
    });

    test("unwrap and token carry no target", () => {
        expect(actionSummary({ type: "unwrap" })).toBe("unwrap");
        expect(actionSummary({ type: "token" })).toBe("token");
    });

    test("tool joins the tool name and its arguments", () => {
        expect(actionSummary({ type: "tool", tool: "example", args: ["$1", "--flag"], approval: "ask" })).toBe(
            "tool example $1 --flag"
        );
    });

    test("service names the port it starts and the page it opens", () => {
        expect(actionSummary({ type: "service", port: 3000, name: "Example", to: "http://localhost:3000$1" })).toBe(
            "start :3000, open http://localhost:3000$1"
        );
    });

    test("run joins the whole argv", () => {
        expect(actionSummary({ type: "run", argv: ["tools", "say", "hi"], approval: "allow" })).toBe(
            "run tools say hi"
        );
    });
});

describe("isEnabled", () => {
    function route(overrides: Partial<RouteRule> = {}): RouteRule {
        return { pattern: "https://example.com/x", action: { type: "unwrap" }, ...overrides };
    }

    const config = { ...defaultRouterConfig(), linkHost: "links.example.test", presets: { mail: {} } };

    test("a route with no preset tag is always enabled", () => {
        expect(isEnabled(route(), config, () => false)).toBe(true);
    });

    test("a preset-tagged route follows the preset: switched on and its capabilities holding", () => {
        expect(isEnabled(route({ preset: "mail" }), config, () => true)).toBe(true);
        expect(isEnabled(route({ preset: "mail" }), config, () => false)).toBe(false);
        expect(isEnabled(route({ preset: "mail" }), { ...config, presets: {} }, () => true)).toBe(false);
    });

    test("an unknown preset id (a stale tag) is not enabled", () => {
        expect(isEnabled(route({ preset: "no-such-preset" }), config, () => true)).toBe(false);
    });
});
