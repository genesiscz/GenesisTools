import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getConfig, saveConfig } from "@app/clarity/config";
import { authStorageSessionStore, ClaritySessionKey } from "@app/clarity/lib/auth/auth-storage-session-store";
import { getAuthSecret, InMemoryBackend, setAuthStorageBackend } from "@genesiscz/utils/storage/AuthStorage";

const Base = { baseUrl: "https://invalid", mappings: [] };

describe("authStorageSessionStore", () => {
    // The test preload already points the config storage at a sandbox home; AuthStorage gets an in-memory backend.
    beforeEach(() => {
        setAuthStorageBackend(new InMemoryBackend());
    });

    afterEach(() => {
        setAuthStorageBackend(null);
    });

    test("a session still in the config file moves to AuthStorage on the first read", async () => {
        await saveConfig({ ...Base, authToken: "token", sessionId: "test", cookies: "sessionId=test" });

        expect(await authStorageSessionStore.read()).toEqual({
            authToken: "token",
            sessionId: "test",
            cookies: "sessionId=test",
        });
        expect(await getAuthSecret(ClaritySessionKey)).toContain('"authToken":"token"');

        const config = await getConfig();
        expect([config?.authToken, config?.sessionId, config?.cookies]).toEqual([undefined, undefined, undefined]);
        expect(config?.baseUrl).toBe("https://invalid");
    });

    test("a write never touches the config file", async () => {
        await saveConfig(Base);
        await authStorageSessionStore.write({ authToken: "fresh", sessionId: "test" });

        expect((await getConfig())?.authToken).toBeUndefined();
        expect((await authStorageSessionStore.read())?.authToken).toBe("fresh");
    });

    test("no session anywhere reads as null", async () => {
        await saveConfig(Base);

        expect(await authStorageSessionStore.read()).toBeNull();
    });
});
