import { describe, expect, test } from "bun:test";
import type { LinkGate } from "@genesiscz/utils/browser-router/link-gate";
import { playLinksFor } from "./link";

function gate(enabled: boolean, linkHost: string | null = "links.example"): LinkGate {
    return {
        version: 2,
        at: Date.now(),
        configMtimeMs: 0,
        installed: true,
        defaultHandler: true,
        httpsHandler: "GenesisTools",
        configured: true,
        linkHost,
        presets: { "meetings-play": { available: true, enabled, routed: enabled, missing: [] } },
    };
}

describe("transcript --play-links", () => {
    test("a preset that is on gives the links and no warning", () => {
        const links = playLinksFor("2026-11-02_15-00-planning", gate(true));

        expect(links.link(83)).toBe("https://links.example/meetings/play?meeting=2026-11-02_15-00-planning&at=01%3A23");
        expect(links.warning).toBeUndefined();
    });

    test("a preset that is off still writes the links, and warns how to switch it on", () => {
        const links = playLinksFor("2026-11-02_15-00-planning", gate(false));

        expect(links.link(83)).toContain("https://links.example/meetings/play?meeting=2026-11-02_15-00-planning");
        expect(links.warning).toContain("presets enable meetings-play");
    });

    test("without a link host there is nothing to link to", () => {
        const links = playLinksFor("2026-11-02_15-00-planning", gate(false, null));

        expect(links.link(83)).toBeNull();
        expect(links.warning).toContain("No play links");
    });
});
