import { describe, expect, it } from "bun:test";
import { env } from "@app/utils/env";
import { env as clientEnv } from "@app/utils/env.client";

describe("env.client", () => {
    it("reads values through the shared env-core", async () => {
        await env.testing.withOverrides({ DASHBOARD_BIND_HOST: "127.0.0.9", NODE_ENV: "production" }, () => {
            expect(clientEnv.dashboard.getBindHost()).toBe("127.0.0.9");
            expect(clientEnv.node.isProduction()).toBe(true);
        });
    });

    it("falls back to defaults when unset", async () => {
        await env.testing.withOverrides({ SQLITE_PATH: undefined, DASHBOARD_BIND_HOST: undefined }, () => {
            expect(clientEnv.db.getSqlitePath()).toBe(".data/dashboard.sqlite");
            expect(clientEnv.dashboard.getBindHost("127.0.0.1")).toBe("127.0.0.1");
        });
    });

    it("stays free of bare-specifier and node builtin imports (client bundles + config inlining)", async () => {
        const source = await Bun.file(new URL("./env.client.ts", import.meta.url)).text();
        const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

        expect(imports.length).toBeGreaterThan(0);
        for (const specifier of imports) {
            expect(specifier.startsWith("./") || specifier.startsWith("../")).toBe(true);
        }
    });

    it("full env re-exposes the client domains from the same source", () => {
        expect(env.dashboard).toBe(clientEnv.dashboard);
        expect(env.db).toBe(clientEnv.db);
        expect(env.node).toBe(clientEnv.node);
        // youtube gains server-only accessors (service key, bind host) on top of
        // the client domain, so identity holds per shared getter, not per object.
        expect(env.youtube.getGitSha).toBe(clientEnv.youtube.getGitSha);
        expect(env.youtube.getUiPort).toBe(clientEnv.youtube.getUiPort);
    });
});
