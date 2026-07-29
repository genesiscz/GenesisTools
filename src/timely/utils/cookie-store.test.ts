import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { clearStoredCookie, readStoredCookie, saveCookie } from "./cookie";

setupStorageSandbox();

const COOKIE = "_memory_session=abc; revision=12";

async function freshStorage(name: string): Promise<Storage> {
    const storage = new Storage(name);
    await storage.ensureDirs();
    return storage;
}

describe("cookie storage", () => {
    test("the cookie lands in its own owner-only file, never in config.json", async () => {
        const storage = await freshStorage("timely-cookie-mode-test");

        const saved = await saveCookie(storage, COOKIE);

        expect(saved.path).toBe(join(storage.getBaseDir(), "cookie"));
        expect(saved.ownerOnly).toBe(true);
        expect(statSync(saved.path).mode & 0o777).toBe(0o600);
        expect(await storage.getConfigValue<string>("cookie")).toBeUndefined();
        expect(await readStoredCookie(storage)).toBe(COOKIE);
    });

    test("saving records when the cookie was stored, for tools timely status", async () => {
        const storage = await freshStorage("timely-cookie-updated-test");
        const before = Math.floor(Date.now() / 1000);

        await saveCookie(storage, COOKIE);

        const updatedAt = await storage.getConfigValue<number>("cookieUpdatedAt");
        expect(updatedAt).toBeGreaterThanOrEqual(before);
    });

    test("a cookie left in config.json by an older build is moved into the 0600 file and removed", async () => {
        const storage = await freshStorage("timely-cookie-migrate-test");
        await storage.setConfigValue("cookie", COOKIE);

        expect(await readStoredCookie(storage)).toBe(COOKIE);

        const path = join(storage.getBaseDir(), "cookie");
        expect(existsSync(path)).toBe(true);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(await storage.getConfigValue<string>("cookie")).toBeUndefined();
    });

    // The cookie is a second credential that works on its own, so logout has to reach it.
    test("clearing removes the cookie file and its metadata, so logout really logs out", async () => {
        const storage = await freshStorage("timely-cookie-clear-test");
        const { path } = await saveCookie(storage, COOKIE);

        const hadCookie = await clearStoredCookie(storage);

        expect(hadCookie).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(await readStoredCookie(storage)).toBeUndefined();
        expect(await storage.getConfigValue<number>("cookieUpdatedAt")).toBeUndefined();
    });

    test("clearing a cookie left in config.json by an older build also revokes it", async () => {
        const storage = await freshStorage("timely-cookie-clear-legacy-test");
        await storage.setConfigValue("cookie", COOKIE);

        const hadCookie = await clearStoredCookie(storage);

        expect(hadCookie).toBe(true);
        expect(await readStoredCookie(storage)).toBeUndefined();
    });

    test("clearing when nothing is stored reports that there was nothing to revoke", async () => {
        const storage = await freshStorage("timely-cookie-clear-empty-test");

        expect(await clearStoredCookie(storage)).toBe(false);
    });

    test("no stored cookie reads as undefined rather than an empty header", async () => {
        const storage = await freshStorage("timely-cookie-absent-test");

        expect(await readStoredCookie(storage)).toBeUndefined();
    });
});
