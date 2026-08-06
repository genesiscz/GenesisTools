import { describe, expect, test } from "bun:test";
import { readKeychainPayload, writeKeychainPayload } from "./keychain";

async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });

    try {
        return await run();
    } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
}

describe("keychain off macOS", () => {
    test("readKeychainPayload returns null instead of throwing", async () => {
        await withPlatform("linux", async () => {
            expect(await readKeychainPayload()).toBeNull();
        });
    });

    test("writeKeychainPayload still refuses loudly", async () => {
        await withPlatform("linux", async () => {
            await expect(writeKeychainPayload({})).rejects.toThrow("only supported on macOS");
        });
    });
});
