import { beforeEach, describe, expect, it } from "bun:test";
import type { NotificationPayload } from "@app/shops/lib/channels/types";
import { WebSseChannel } from "@app/shops/lib/channels/WebSseChannel";
import { sseBroadcaster } from "@app/shops/lib/sse-broadcaster";

const PAYLOAD: NotificationPayload = {
    notification: {
        id: 1,
        favorite_id: 10,
        master_product_id: 20,
        product_id: 30,
        fired_at: "2026-05-08T10:00:00Z",
        reason: "target-price",
        prev_price: 50,
        curr_price: 39.9,
        shop_origin: "rohlik.cz",
        delivered_macos_at: null,
        delivered_web_at: null,
        delivered_telegram_at: null,
        delivery_error: null,
        acknowledged_at: null,
        metadata_json: "{}",
    },
    title: "Ritter Sport — 39.9 CZK",
    body: "Best price on rohlík.",
    detailUrl: "/master/20",
    buyUrl: "https://www.rohlik.cz/30",
};

beforeEach(() => sseBroadcaster.reset());

describe("WebSseChannel", () => {
    it("is always available", () => {
        expect(new WebSseChannel().available()).toBe(true);
    });

    it("dispatch publishes a notification-fired event to all subscribers", async () => {
        const ch = new WebSseChannel();
        const { stream } = sseBroadcaster.subscribe();
        const reader = stream.getReader();
        await reader.read();

        const result = await ch.dispatch(PAYLOAD);
        expect(result).toEqual({ channel: "web", delivered: true });

        const { value } = await reader.read();
        const frame = new TextDecoder().decode(value ?? new Uint8Array());
        expect(frame).toContain("event: notification-fired");
        expect(frame).toContain('"id":1');
        expect(frame).toContain('"buyUrl":"https://www.rohlik.cz/30"');
        await reader.cancel();
    });

    it("dispatch returns delivered:true even when there are zero subscribers", async () => {
        const ch = new WebSseChannel();
        const result = await ch.dispatch(PAYLOAD);
        expect(result).toEqual({ channel: "web", delivered: true });
    });
});
