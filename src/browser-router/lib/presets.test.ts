import { describe, expect, test } from "bun:test";
import { applyPresets, type Preset } from "./presets";
import { LEGACY_LOCAL_CATCH_ALL, type RouteRule } from "./route";

const genesis: Preset = {
    id: "genesis-md",
    title: "Genesis Markdown",
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
        const hidden = applyPresets(routes, [{ ...genesis, installed: false }]);

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
        expect(applyPresets(routes, [{ ...genesis, installed: false }]).map((route) => route.pattern)).toEqual([
            user.pattern,
        ]);
    });
});
