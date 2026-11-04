import { describe, expect, it } from "bun:test";
import { MacOsChannel } from "@app/shops/lib/channels/MacOsChannel";
import type { NotificationPayload } from "@app/shops/lib/channels/types";
import type { NotificationEvent } from "@genesiscz/utils/notifications";

const PAYLOAD: NotificationPayload = {
    notification: {
        id: 1,
        user_id: 1,
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
    body: "Best price on rohlík",
    detailUrl: "/master/20",
    buyUrl: "https://www.rohlik.cz/30",
};

function spyChannel(answer: { ok: boolean; detail?: string } = { ok: true }, unusable?: string) {
    const events: NotificationEvent[] = [];
    const channel = new MacOsChannel({
        post: async (event) => {
            events.push(event);
            return answer;
        },
        unusable: () => unusable,
    });
    return { channel, events };
}

describe("MacOsChannel", () => {
    it("available() follows the system channel's usable check", () => {
        expect(spyChannel().channel.available()).toBe(true);
        expect(spyChannel({ ok: true }, "macOS only").channel.available()).toBe(false);
    });

    it("dispatch returns delivered:false (no error) when the system channel cannot post here", async () => {
        const { channel, events } = spyChannel({ ok: true }, "macOS only");
        const result = await channel.dispatch(PAYLOAD);
        expect(result).toEqual({ channel: "macos", delivered: false });
        expect(events).toHaveLength(0);
    });

    it("dispatch posts the title, body, buy link and product group through the system channel", async () => {
        const { channel, events } = spyChannel();
        const result = await channel.dispatch(PAYLOAD);
        expect(result).toEqual({ channel: "macos", delivered: true });
        expect(events[0]).toMatchObject({
            app: "shops",
            title: "Ritter Sport — 39.9 CZK",
            message: "Best price on rohlík",
            open: "https://www.rohlik.cz/30",
            group: "shops-20",
        });
    });

    it("dispatch returns delivered:false + error when the channel refuses", async () => {
        const { channel } = spyChannel({ ok: false, detail: "banner not confirmed" });
        const result = await channel.dispatch(PAYLOAD);
        expect(result.delivered).toBe(false);
        expect(result.error).toContain("banner not confirmed");
    });
});
