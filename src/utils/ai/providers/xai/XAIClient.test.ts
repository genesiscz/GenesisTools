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

test("an injected transport receives transcription requests and the bound key", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const transport: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
        return new Response("ok");
    }, { preconnect: fetch.preconnect });
    const client = new XAIClient("fixture-key", { fetch: transport });
    expect(await (await client.fetch("/stt", { method: "POST" })).text()).toBe("ok");
    expect(requests).toEqual([{ url: "https://api.x.ai/v1/stt", authorization: "Bearer fixture-key" }]);
});
