import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getConfig, saveConfig } from "@app/clarity/config";
import { authStorageSessionStore, ClaritySessionKey } from "@app/clarity/lib/auth/auth-storage-session-store";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    getAuthSecret,
    InMemoryBackend,
    setAuthSecret,
    setAuthStorageBackend,
} from "@genesiscz/utils/storage/AuthStorage";

const Base = { baseUrl: "https://invalid", mappings: [] };

describe("authStorageSessionStore", () => {
    // The test preload already points the config storage at a sandbox home; AuthStorage gets an in-memory backend.
    beforeEach(() => {
        setAuthStorageBackend(new InMemoryBackend());
    });

    afterEach(() => {
        setAuthStorageBackend(null);
    });

    test("a session still in the config file is read from there, and the read writes neither store", async () => {
        const legacy = { ...Base, authToken: "token", sessionId: "test", cookies: "sessionId=test" };
        await saveConfig(legacy);

        expect(await authStorageSessionStore.read(Base.baseUrl)).toEqual({
            authToken: "token",
            sessionId: "test",
            cookies: "sessionId=test",
        });
        expect(await getAuthSecret(ClaritySessionKey)).toBeNull();
        expect(await getConfig()).toMatchObject(legacy);
    });

    test("a write never touches the config file", async () => {
        await saveConfig(Base);
        await authStorageSessionStore.write({ authToken: "fresh", sessionId: "test" }, Base.baseUrl);

        expect((await getConfig())?.authToken).toBeUndefined();
        expect((await authStorageSessionStore.read(Base.baseUrl))?.authToken).toBe("fresh");
    });

    test("a session saved for one server is never handed to a copy set up for another", async () => {
        await saveConfig(Base);
        await authStorageSessionStore.write({ authToken: "fresh", sessionId: "test" }, "https://clarity.example.com/");

        expect(await authStorageSessionStore.read("https://other.example.com")).toBeNull();
        expect((await authStorageSessionStore.read("https://clarity.example.com/ppm"))?.authToken).toBe("fresh");

        // An item written before the item named its server (a copy that does not bind it) is no server's session.
        await setAuthSecret(ClaritySessionKey, SafeJSON.stringify({ authToken: "old", sessionId: "test" }) ?? "");
        expect(await authStorageSessionStore.read("https://clarity.example.com")).toBeNull();
    });

    test("no session anywhere reads as null", async () => {
        await saveConfig(Base);

        expect(await authStorageSessionStore.read(Base.baseUrl)).toBeNull();
    });
});
