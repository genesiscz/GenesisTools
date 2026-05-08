import { describe, expect, it } from "bun:test";
import { buildRegistry, getAdvertisedTools, getHandler } from "./registry";

const WRITE_TOOLS = [
    "shops_ingest",
    "shops_accept_match",
    "shops_watch_add",
    "shops_watch_remove",
    "shops_notify_ack",
] as const;

describe("write-tool defense in depth", () => {
    it("getAdvertisedTools(false) hides every write tool", () => {
        const advertised = getAdvertisedTools(buildRegistry(), false);
        const advertisedNames = new Set(advertised.map((t) => t.name));
        for (const name of WRITE_TOOLS) {
            expect(advertisedNames.has(name)).toBe(false);
        }
    });

    it("getHandler returns writeBlocked for every write tool when allowWrite=false", () => {
        const reg = buildRegistry();
        for (const name of WRITE_TOOLS) {
            const result = getHandler(reg, name, false);
            expect(result.kind).toBe("writeBlocked");
        }
    });

    it("getHandler returns ok for every write tool when allowWrite=true", () => {
        const reg = buildRegistry();
        for (const name of WRITE_TOOLS) {
            const result = getHandler(reg, name, true);
            expect(result.kind).toBe("ok");
        }
    });
});
