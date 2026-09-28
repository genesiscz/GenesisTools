import { expect, test } from "bun:test";
import { XAIClient } from "./XAIClient";

test("a lookup that expired and then fails never drops the lookup that replaced it", async () => {
    let clock = 0;
    let calls = 0;
    let failOld: (error: Error) => void = () => {};
    const client = new XAIClient(undefined, {
        now: () => clock,
        lookup: () => {
            calls++;

            if (calls === 1) {
                return new Promise<string>((_, reject) => {
                    failOld = reject;
                });
            }

            return Promise.resolve("key-2");
        },
    });

    const old = client.requireKey();
    clock = 61_000;
    expect(await client.requireKey()).toBe("key-2");

    failOld(new Error("vault locked"));
    await expect(old).rejects.toThrow("vault locked");
    expect(await client.requireKey()).toBe("key-2");
    expect(calls).toBe(2);
});

test("a failed lookup is not kept: the next call asks again", async () => {
    let calls = 0;
    const client = new XAIClient(undefined, {
        now: () => 0,
        lookup: async () => {
            calls++;

            if (calls === 1) {
                throw new Error("no account");
            }

            return "key";
        },
    });

    await expect(client.requireKey()).rejects.toThrow("no account");
    expect(await client.requireKey()).toBe("key");
});
