import { describe, expect, test } from "bun:test";
import { buildDashboardUiServerCmd, buildViteDevCmd, DEFAULT_BIND_HOST } from "./viteSpawn";

describe("buildViteDevCmd", () => {
    test("defaults to localhost bind", () => {
        const cmd = buildViteDevCmd({ configPath: "/tmp/vite.config.ts", strictPort: true });

        expect(cmd).toContain("--host");
        expect(cmd).toContain(DEFAULT_BIND_HOST);
        expect(cmd).toContain("--strictPort");
    });

    test("supports all-interfaces bind", () => {
        const cmd = buildViteDevCmd({
            configPath: "/tmp/vite.config.ts",
            bindHost: "0.0.0.0",
            port: 3071,
        });

        expect(cmd).toEqual(expect.arrayContaining(["--host", "0.0.0.0", "--port", "3071"]));
    });
});

describe("buildDashboardUiServerCmd", () => {
    test("defaults to preview __ui-server", () => {
        expect(buildDashboardUiServerCmd({ serverScript: "/x/dev-dashboard/index.ts" })).toEqual([
            "bun",
            "/x/dev-dashboard/index.ts",
            "__ui-server",
        ]);
    });

    test("dev mode passes --dev", () => {
        expect(buildDashboardUiServerCmd({ serverScript: "/x/index.ts", mode: "dev" })).toEqual([
            "bun",
            "/x/index.ts",
            "__ui-server",
            "--dev",
        ]);
    });
});
