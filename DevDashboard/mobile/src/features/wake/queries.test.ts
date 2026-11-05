import { describe, expect, it, spyOn } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_HEALTH, MOCK_WAKE } from "@/api/fixtures/wake";
import { healthQuery, relayQuery, sendWake, wakeRequest } from "@/features/wake/queries";

describe("Wake my Mac", () => {
    it("reads the relay and the health probe through the real client", async () => {
        expect(await relayQuery(fixtureDashboardClient).queryFn?.({} as never)).toEqual(MOCK_WAKE);
        expect(await healthQuery(fixtureDashboardClient).queryFn?.({} as never)).toEqual(MOCK_HEALTH);
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
                        return new Response(new ReadableStream({
                            start(stream) {
                                init.signal!.addEventListener("abort", () => stream.error(new Error("aborted")));
                            },
                        }));
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
        const refused = await sendWake(MOCK_WAKE, async () => new Response('{"error":"invalid password"}', { status: 401 }));
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
