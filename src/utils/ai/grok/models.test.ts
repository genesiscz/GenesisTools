import { describe, expect, it } from "bun:test";
import { inferModelThinking, pickerCacheRecords } from "@genesiscz/utils/ai/grok/models";

describe("inferModelThinking", () => {
    it("returns none for non-reasoning model ids instead of matching the broader reasoning regex", () => {
        expect(inferModelThinking("grok-4-1-fast-non-reasoning")).toBe("none");
    });

    it("still returns reasoning for ids that genuinely indicate reasoning", () => {
        expect(inferModelThinking("grok-4-1-reasoning")).toBe("reasoning");
        expect(inferModelThinking("grok-build")).toBe("reasoning");
    });
});

describe("pickerCacheRecords", () => {
    const cache = {
        models: {
            "grok-4.6": {
                info: { id: "grok-4.6", context_window: 500_000, api_backend: "responses", hidden: false },
            },
            "grok-9-fast": { info: { id: "grok-9-fast", context_window: 2_000_000 } },
            "grok-secret": { info: { id: "grok-secret", hidden: true } },
            "grok-webonly": { info: { id: "grok-webonly", supported_in_api: false } },
        },
    };

    it("turns the grok CLI's live picker cache into records", () => {
        const ids = pickerCacheRecords(cache).map((record) => record.id);

        expect(ids).toEqual(["grok-4.6", "grok-9-fast"]);
    });

    it("carries the real context window instead of a static guess", () => {
        const record = pickerCacheRecords(cache).find((entry) => entry.id === "grok-4.6");

        expect(record?.context_window).toBe(500_000);
        expect(record?.api_backend).toBe("responses");
        expect(record?.source).toBe("picker");
        // Unset, not "ok": nothing was probed here, and a fabricated ok would
        // re-advertise an id whose real probe said "fail".
        expect(record?.probeStatus).toBeUndefined();
    });

    it("omits keys the cache does not carry, so the merge cannot wipe probed values", () => {
        const record = pickerCacheRecords(cache).find((entry) => entry.id === "grok-9-fast");

        expect(record !== undefined && "api_backend" in record).toBe(false);
        expect(record !== undefined && "agent_type" in record).toBe(false);
    });

    it("infers speed and thinking for an id nobody has curated yet", () => {
        // The whole point: a model xAI ships tomorrow is usable with no repo edit.
        const record = pickerCacheRecords(cache).find((entry) => entry.id === "grok-9-fast");

        expect(record?.speed).toBe("fast");
        expect(record?.thinking).toBe("none");
    });

    it("drops hidden and non-api entries — the picker ships ids it will 404 on", () => {
        const ids = pickerCacheRecords(cache).map((record) => record.id);

        expect(ids).not.toContain("grok-secret");
        expect(ids).not.toContain("grok-webonly");
    });

    it("survives a malformed or empty cache", () => {
        expect(pickerCacheRecords({})).toEqual([]);
        expect(pickerCacheRecords({ models: null })).toEqual([]);
        expect(pickerCacheRecords({ models: { bad: "not an object" } })).toEqual([]);
        // Arrays are objects. Walked by index, each element would become a
        // healthy-looking model advertised under a numeric id — and unpriced.
        expect(pickerCacheRecords({ models: [{ info: {} }, { info: {} }] })).toEqual([]);
        expect(pickerCacheRecords({ models: { bad: [] } })).toEqual([]);
    });
});
