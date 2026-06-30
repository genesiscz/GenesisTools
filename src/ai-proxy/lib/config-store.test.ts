import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAiProxyConfigStore, parseConfigJson, resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

const originalHome = env.get("GENESIS_TOOLS_HOME");

afterEach(() => {
    resetAiProxyConfigStore();
    resetAiProxyStorage();

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("config-store migration", () => {
    it("migrates legacy flat public fields to cloudflared mode", () => {
        const config = parseConfigJson(
            SafeJSON.stringify({
                public: {
                    hostname: "proxy.example.dev",
                    basePath: "/ai",
                    tunnelName: "home-tunnel",
                },
            })
        );

        expect(config.public?.mode).toBe("cloudflared");
        expect(config.public?.cloudflared?.tunnelName).toBe("home-tunnel");
        expect(config.public?.tunnelName).toBeUndefined();
    });

    it("defaults thinking presentation to cursor", () => {
        const config = parseConfigJson(SafeJSON.stringify({}));
        expect(config.translation.thinking).toBe("cursor");
    });

    it("loadFresh reads disk without stale in-process cache", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ai-proxy-config-"));
        env.testing.set("GENESIS_TOOLS_HOME", tempDir);
        resetAiProxyConfigStore();
        resetAiProxyStorage();

        const storage = getAiProxyStorage();
        mkdirSync(join(storage.getBaseDir()), { recursive: true });
        const configPath = storage.getConfigPath();
        const store = getAiProxyConfigStore();

        writeFileSync(
            configPath,
            SafeJSON.stringify({
                translation: { cursorAgent: "auto", thinking: "cursor" },
                accounts: [],
            })
        );

        await store.load();

        writeFileSync(
            configPath,
            SafeJSON.stringify({
                translation: { cursorAgent: "auto", thinking: "raw" },
                accounts: [],
            })
        );

        const cached = await store.load();
        expect(cached.translation.thinking).toBe("cursor");

        const fresh = await store.loadFresh();
        expect(fresh.translation.thinking).toBe("raw");

        rmSync(tempDir, { recursive: true, force: true });
    });
});
