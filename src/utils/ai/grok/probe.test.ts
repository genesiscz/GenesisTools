import { describe, expect, it } from "bun:test";
import { GROK_PROBE_CANDIDATES, GROK_STATIC_CATALOG, inferModelThinking, mergeModelCatalog, toProxyId } from "./models";

describe("grok probe helpers", () => {
    it("includes researched static catalog ids (working only — no fail seeds)", () => {
        expect(GROK_STATIC_CATALOG.some((model) => model.id === "grok-composer-2.5-fast")).toBe(true);
        expect(GROK_STATIC_CATALOG.every((model) => model.probeStatus !== "fail")).toBe(true);
        expect(GROK_STATIC_CATALOG.length).toBeGreaterThanOrEqual(20);
    });

    it("treats grok-composer models as required reasoning, not optional", () => {
        expect(inferModelThinking("grok-composer-2.5-fast")).toBe("reasoning");
        expect(inferModelThinking("grok-composer-2.5")).toBe("reasoning");
        expect(GROK_STATIC_CATALOG.find((model) => model.id === "grok-composer-2.5-fast")?.thinking).toBe("reasoning");
    });

    it("merges picker models over static catalog", () => {
        const merged = mergeModelCatalog(
            [
                {
                    id: "grok-build",
                    source: "picker",
                    visibility: "high",
                    speed: "slow",
                    thinking: "reasoning",
                },
            ],
            []
        );

        expect(merged.find((model) => model.id === "grok-build")?.source).toBe("picker");
        expect(merged.find((model) => model.id === "grok-4.3")).toBeTruthy();
    });

    it("builds canonical proxy ids", () => {
        expect(toProxyId("martin", "grok", "grok-composer-2.5-fast")).toBe("martin/grok/grok-composer-2.5-fast");
    });

    it("keeps probe candidates unique", () => {
        const unique = new Set(GROK_PROBE_CANDIDATES);
        expect(unique.size).toBe(GROK_PROBE_CANDIDATES.length);
    });
});
