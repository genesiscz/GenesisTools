import { describe, expect, test } from "bun:test";
import { buildChannelOverride } from "./channel-override";

describe("buildChannelOverride", () => {
    test("sends only the edited field, not every inherited global value", () => {
        // The draft is seeded from the RESOLVED view (global merged with the app
        // override), so sending all of it pinned `sound`, `title` and `voice` as
        // monitor overrides the user never asked for.
        const draft = { enabled: true, chatId: "-200", botTokenSet: true, sound: "Ping", title: "Monitor" };

        expect(buildChannelOverride(draft, ["chatId"])).toEqual({ chatId: "-200" });
    });

    test("an emptied field is sent as an empty string, which is the API's clear path", () => {
        expect(buildChannelOverride({ sound: "" }, ["sound"])).toEqual({ sound: "" });
    });

    test("booleans are carried and the masked secret marker is never written", () => {
        expect(buildChannelOverride({ enabled: false, botTokenSet: true }, ["enabled", "botTokenSet"])).toEqual({
            enabled: false,
        });
    });

    test("a field that was never edited is absent even when the draft holds a value", () => {
        expect(buildChannelOverride({ voice: "Samantha" }, [])).toEqual({});
    });
});
