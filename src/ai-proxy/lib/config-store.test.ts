import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ConfigPermissionOps,
    checkConfigPermissions,
    getAiProxyConfigStore,
    isReadableByOthers,
    parseConfigJson,
    resetAiProxyConfigStore,
} from "@app/ai-proxy/lib/config-store";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

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

    it("keeps the saved config owner-only, since it stores billed api keys in plain text", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ai-proxy-config-mode-"));
        env.testing.set("GENESIS_TOOLS_HOME", tempDir);
        resetAiProxyConfigStore();
        resetAiProxyStorage();

        const store = getAiProxyConfigStore();
        const config = await store.load();
        config.accounts = [
            { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true, apiKey: "xai-secret-value" },
        ];

        await store.save(config);

        // The mode is carried by the temp file through the rename, so it holds
        // on the very first save rather than being applied after publication.
        expect(statSync(getAiProxyStorage().getConfigPath()).mode & 0o777).toBe(0o600);

        await store.save(config);
        expect(statSync(getAiProxyStorage().getConfigPath()).mode & 0o777).toBe(0o600);

        rmSync(tempDir, { recursive: true, force: true });
    });
});

describe("checkConfigPermissions", () => {
    // Never opened — every filesystem call is injected. It only has to look like
    // a config path in the warning the function logs.
    const fakeConfigPath = join(tmpdir(), "ai-proxy-permissions", "config.json");

    function recordingOps(behaviour: { chmod?: () => Promise<void>; statMode?: () => Promise<number> }): {
        ops: ConfigPermissionOps;
        calls: { chmod: number[]; stat: number };
    } {
        const calls = { chmod: [] as number[], stat: 0 };

        return {
            calls,
            ops: {
                chmod: async (_path, mode) => {
                    calls.chmod.push(mode);
                    await behaviour.chmod?.();
                },
                statMode: async () => {
                    calls.stat += 1;
                    return (await behaviour.statMode?.()) ?? 0o600;
                },
            },
        };
    }

    it("reports nothing when the file ends up owner-only", async () => {
        const { ops, calls } = recordingOps({ statMode: async () => 0o600 });

        expect(await checkConfigPermissions(fakeConfigPath, ops)).toBeUndefined();
        expect(calls.chmod).toEqual([0o600]);
    });

    it("reports the RESULTING mode when chmod succeeded but changed nothing", async () => {
        // The exFAT / network-mount case: chmod resolves, the mode is untouched.
        // Reporting the requested 0600 here would tell the user the file is safe.
        const { ops, calls } = recordingOps({ statMode: async () => 0o644 });

        expect(await checkConfigPermissions(fakeConfigPath, ops)).toBe("644");
        // A regression that stops re-reading the mode would make this 0.
        expect(calls.stat).toBe(1);
    });

    it("reports a group-readable result too, not just world-readable", async () => {
        const { ops } = recordingOps({ statMode: async () => 0o640 });

        expect(await checkConfigPermissions(fakeConfigPath, ops)).toBe("640");
    });

    it("reports unknown when chmod is rejected", async () => {
        const { ops, calls } = recordingOps({
            chmod: async () => {
                throw new Error("EPERM");
            },
        });

        expect(await checkConfigPermissions(fakeConfigPath, ops)).toBe("unknown");
        // The mode is unknowable, so it must not silently pass as owner-only.
        expect(calls.stat).toBe(0);
    });

    it("reports unknown when the mode cannot be read back", async () => {
        const { ops } = recordingOps({
            statMode: async () => {
                throw new Error("ENOENT");
            },
        });

        expect(await checkConfigPermissions(fakeConfigPath, ops)).toBe("unknown");
    });
});

describe("isReadableByOthers", () => {
    it("accepts owner-only modes", () => {
        expect(isReadableByOthers(0o600)).toBe(false);
        // Stricter than required is still fine — flagging 0o400 would send the
        // user a `chmod 600` for a file that is already safe.
        expect(isReadableByOthers(0o400)).toBe(false);
        expect(isReadableByOthers(0o000)).toBe(false);
    });

    it("rejects anything a group or other user can reach", () => {
        expect(isReadableByOthers(0o640)).toBe(true);
        expect(isReadableByOthers(0o604)).toBe(true);
        expect(isReadableByOthers(0o644)).toBe(true);
        // Execute-only counts: it still grants a bit to somebody else.
        expect(isReadableByOthers(0o601)).toBe(true);
        expect(isReadableByOthers(0o610)).toBe(true);
    });
});
