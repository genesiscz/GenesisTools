import { describe, expect, it } from "bun:test";
import { parseSessionKey, sessionKey } from "./session-key";

describe("parseSessionKey", () => {
    it("parses dash-format collision-suffixed names", () => {
        expect(parseSessionKey("task:col-fe-2026-05-26_03-59-30")).toEqual({
            source: "task",
            name: "col-fe-2026-05-26_03-59-30",
        });
    });

    it("parses plain session names without dashes", () => {
        expect(parseSessionKey("debugging-master:eval2-storm")).toEqual({
            source: "debugging-master",
            name: "eval2-storm",
        });
    });

    it("round-trips via sessionKey", () => {
        const key = sessionKey("task", "col-fe-2026-05-26_03-59-30");
        expect(parseSessionKey(key)).toEqual({
            source: "task",
            name: "col-fe-2026-05-26_03-59-30",
        });
    });

    it("returns null for invalid keys", () => {
        expect(parseSessionKey("")).toBeNull();
        expect(parseSessionKey("unknown:foo")).toBeNull();
        expect(parseSessionKey("task:")).toBeNull();
        expect(parseSessionKey(":foo")).toBeNull();
    });
});
