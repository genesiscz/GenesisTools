import { describe, expect, it } from "bun:test";
import { MacOsChannel } from "@app/shops/lib/channels/MacOsChannel";
import type { NotificationPayload } from "@app/shops/lib/channels/types";

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

describe("MacOsChannel", () => {
    it("available() reflects whether either binary is present", () => {
        expect(
            new MacOsChannel({
                terminalNotifierPath: "/x",
                osascriptPath: null,
                spawn: () => ({ exited: Promise.resolve(0) }),
            }).available()
        ).toBe(true);
        expect(
            new MacOsChannel({
                terminalNotifierPath: null,
                osascriptPath: "/x",
                spawn: () => ({ exited: Promise.resolve(0) }),
            }).available()
        ).toBe(true);
        expect(
            new MacOsChannel({
                terminalNotifierPath: null,
                osascriptPath: null,
                spawn: () => ({ exited: Promise.resolve(0) }),
            }).available()
        ).toBe(false);
    });

    it("dispatch returns delivered:false (no error) when neither binary is available", async () => {
        const ch = new MacOsChannel({
            terminalNotifierPath: null,
            osascriptPath: null,
            spawn: () => ({ exited: Promise.resolve(0) }),
        });
        const result = await ch.dispatch(PAYLOAD);
        expect(result.channel).toBe("macos");
        expect(result.delivered).toBe(false);
        expect(result.error).toBeUndefined();
    });

    it("dispatch invokes terminal-notifier when available with -title -message -open", async () => {
        const calls: string[][] = [];
        const ch = new MacOsChannel({
            terminalNotifierPath: "/opt/homebrew/bin/terminal-notifier",
            osascriptPath: null,
            spawn: (cmd: string[]) => {
                calls.push(cmd);
                return { exited: Promise.resolve(0) };
            },
        });
        const result = await ch.dispatch(PAYLOAD);
        expect(result.delivered).toBe(true);
        expect(calls[0][0]).toBe("/opt/homebrew/bin/terminal-notifier");
        expect(calls[0]).toContain("-title");
        expect(calls[0]).toContain("Ritter Sport — 39.9 CZK");
        expect(calls[0]).toContain("-open");
        expect(calls[0]).toContain("https://www.rohlik.cz/30");
    });

    it("dispatch falls back to osascript when terminal-notifier missing", async () => {
        const calls: string[][] = [];
        const ch = new MacOsChannel({
            terminalNotifierPath: null,
            osascriptPath: "/usr/bin/osascript",
            spawn: (cmd: string[]) => {
                calls.push(cmd);
                return { exited: Promise.resolve(0) };
            },
        });
        const result = await ch.dispatch(PAYLOAD);
        expect(result.delivered).toBe(true);
        expect(calls[0][0]).toBe("/usr/bin/osascript");
        expect(calls[0]).toContain("-e");
        expect(calls[0].join(" ")).toContain("display notification");
        expect(calls[0].join(" ")).toContain("Ritter Sport");
    });

    it("dispatch returns delivered:false + error on non-zero exit", async () => {
        const ch = new MacOsChannel({
            terminalNotifierPath: "/opt/homebrew/bin/terminal-notifier",
            osascriptPath: null,
            spawn: () => ({ exited: Promise.resolve(2) }),
        });
        const result = await ch.dispatch(PAYLOAD);
        expect(result.delivered).toBe(false);
        expect(result.error).toContain("exit");
    });
});
