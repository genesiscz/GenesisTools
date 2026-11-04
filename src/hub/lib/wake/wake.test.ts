import { describe, expect, it } from "bun:test";
import { wakeRelayOf } from "./index";

describe("wakeRelayOf", () => {
    it("gives the phone the relay address and this Mac's device login", () => {
        const relay = wakeRelayOf({
            role: "client",
            client: { name: "desk-mac", password: "pw", serverHost: "relay.example.lan", serverPort: 8787 },
        });

        expect(relay).toEqual({
            configured: true,
            url: "http://relay.example.lan:8787",
            name: "desk-mac",
            password: "pw",
            token: null,
            note: null,
        });
    });

    it("says why it cannot wake: no login yet, or a relay that sleeps with this Mac", () => {
        const none = wakeRelayOf({});
        const local = wakeRelayOf({ client: { name: "desk-mac", password: "pw", serverHost: "127.0.0.1" } });

        expect(none).toMatchObject({ configured: false, url: null, password: null });
        expect(none.note).toContain("wakeup login");
        expect(local.configured).toBe(true);
        expect(local.note).toContain("always-on machine");
        expect(wakeRelayOf({ client: { name: "m", password: "p", serverHost: "https://relay.example.lan" } }).url).toBe(
            "https://relay.example.lan:8787"
        );
    });
});
