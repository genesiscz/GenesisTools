import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const originalChrome = globalThis.chrome;

describe("extension api bridge", () => {
    beforeEach(() => {
        globalThis.chrome = {
            runtime: {
                sendMessage: async () => ({ ok: true, data: { value: 42 } }),
            },
        } as unknown as typeof chrome;
    });

    afterEach(() => {
        globalThis.chrome = originalChrome;
    });

    it("resolves successful runtime responses", async () => {
        const { send } = await import("@ext/api.bridge");

        await expect(send<{ value: number }>({ type: "config:get" })).resolves.toEqual({ value: 42 });
    });

    it("throws failed runtime responses", async () => {
        globalThis.chrome = {
            runtime: {
                sendMessage: async () => ({ ok: false, error: "nope" }),
            },
        } as unknown as typeof chrome;
        const { send } = await import("@ext/api.bridge");

        await expect(send({ type: "config:get" })).rejects.toThrow("nope");
    });
});
