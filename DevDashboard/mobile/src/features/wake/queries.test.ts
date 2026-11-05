import { describe, expect, it, spyOn } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_HEALTH, MOCK_WAKE } from "@/api/fixtures/wake";
import { healthQuery, relayQuery, sendWake, wakeRequest } from "@/features/wake/queries";
import { createRelayStore } from "@/features/wake/relay-store";

function storageFixture() {
    const values = new Map<string, string>();
    const reads: string[] = [];
    const store = createRelayStore({
        getItemAsync: async (key) => {
            reads.push(key);
            return values.get(key) ?? null;
        },
        setItemAsync: async (key, value) => {
            values.set(key, value);
        },
    });
    return { store, values, reads };
}

describe("Wake my Mac", () => {
    it("reads the relay and the health probe through the real client", async () => {
        expect(
            await relayQuery({
                client: fixtureDashboardClient,
                connectionId: "mac-a",
                store: storageFixture().store,
            }).queryFn?.({} as never)
        ).toEqual(MOCK_WAKE);
        expect(await healthQuery(fixtureDashboardClient).queryFn?.({} as never)).toEqual(MOCK_HEALTH);
    });

    it("isolates saved relays, ignores the legacy record, and encodes arbitrary connection IDs", async () => {
        const { store, values, reads } = storageFixture();
        values.set("dd_wake_relay", JSON.stringify(MOCK_WAKE));
        expect(await store.load("mac-b")).toBeNull();
        const macA = "mac:/a ☃";
        const relayB = { ...MOCK_WAKE, name: "mac-b", password: "password-b" };
        await store.save(macA, MOCK_WAKE);
        await store.save("mac-b", relayB);
        expect(await store.load(macA)).toEqual(MOCK_WAKE);
        expect(await store.load("mac-b")).toEqual(relayB);
        expect(reads).not.toContain("dd_wake_relay");
        expect([...values.keys()].every((key) => /^[a-zA-Z0-9._-]+$/.test(key))).toBe(true);
        expect(values.size).toBe(3);
    });

    it("saves a late reply under the connection captured by the query", async () => {
        const { store } = storageFixture();
        const reply = Promise.withResolvers<typeof MOCK_WAKE>();
        const client = { ...fixtureDashboardClient, call: (() => reply.promise) as typeof fixtureDashboardClient.call };
        let connectionId = "mac-a";
        const options = relayQuery({ client, connectionId, store });
        const pending = options.queryFn!({} as never);
        connectionId = "mac-b";
        const next = relayQuery({ client: fixtureDashboardClient, connectionId, store });
        expect(next.queryKey).not.toEqual(options.queryKey);
        reply.resolve(MOCK_WAKE);
        expect(await pending).toEqual(MOCK_WAKE);
        expect(await store.load("mac-a")).toEqual(MOCK_WAKE);
        expect(await store.load(connectionId)).toBeNull();
    });

    it("posts the relay's /wake with the device login, and a bearer token when the relay has one", () => {
        const plain = wakeRequest(MOCK_WAKE);
        const tokened = wakeRequest({ ...MOCK_WAKE, url: "http://relay.example.lan:8787/", token: "t1" });

        expect(plain?.url).toBe("http://relay.example.lan:8787/wake");
        expect(plain?.init.body).toBe('{"name":"desk-mac","password":"fixture-password"}');
        expect(tokened?.url).toBe("http://relay.example.lan:8787/wake");
        expect(tokened?.init.headers).toMatchObject({ Authorization: "Bearer t1" });
        expect(wakeRequest({ ...MOCK_WAKE, configured: false })).toBeNull();
    });

    it("bounds both the connection and a stalled response body", async () => {
        for (const bodyStalls of [false, true]) {
            const controller = new AbortController();
            const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
            try {
                const pending = sendWake(MOCK_WAKE, async (_url, init) => {
                    expect(init.signal).toBe(controller.signal);
                    if (bodyStalls) {
                        return new Response(
                            new ReadableStream({
                                start(stream) {
                                    init.signal!.addEventListener("abort", () => stream.error(new Error("aborted")));
                                },
                            })
                        );
                    }
                    return new Promise<Response>((_resolve, reject) => {
                        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
                    });
                });
                await Promise.resolve();
                controller.abort();
                expect(await pending).toMatchObject({ sent: false, detail: expect.stringContaining("timed out") });
                expect(timeout).toHaveBeenCalledWith(10_000);
            } finally {
                timeout.mockRestore();
            }
        }
    });

    it("reports a relay refusal and an unreachable relay without throwing", async () => {
        const refused = await sendWake(
            MOCK_WAKE,
            async () => new Response('{"error":"invalid password"}', { status: 401 })
        );
        const unreachable = await sendWake(MOCK_WAKE, async () => {
            throw new Error("network down");
        });
        const sent = await sendWake(MOCK_WAKE, async () => new Response('{"ok":true}'));

        expect(refused.sent).toBe(false);
        expect(refused.detail).toContain("401");
        expect(unreachable.detail).toContain("network down");
        expect(sent.sent).toBe(true);
        expect((await sendWake(null)).sent).toBe(false);
    });
});
