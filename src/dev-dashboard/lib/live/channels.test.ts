import { describe, expect, test } from "bun:test";
import { isLiveChannel, parseChannels, parseChannelsQuery } from "./channels";

describe("parseChannelsQuery", () => {
    test("splits, dedupes, drops invalid", () => {
        expect(parseChannelsQuery("ports,pulse,ports,nope")).toEqual(["ports", "pulse"]);
    });

    test("every channel of the producer table is known", () => {
        for (const name of ["ports", "pulse", "ai-usage", "qa", "decisions", "pending", "handoffs"]) {
            expect(isLiveChannel(name)).toBe(true);
        }

        expect(isLiveChannel("ai-usage-nope")).toBe(false);
        expect(isLiveChannel("toString")).toBe(false);
    });

    test("the removed board and daemon channels are refused", () => {
        expect(isLiveChannel("boards:foo")).toBe(false);
        expect(isLiveChannel("daemon:/tmp/x.log")).toBe(false);
    });

    test("a subscribe body drops values that are not strings", () => {
        expect(parseChannels(["qa", 3, "qa", null, "pending"])).toEqual(["qa", "pending"]);
    });

    test("empty", () => {
        expect(parseChannelsQuery(null)).toEqual([]);
        expect(parseChannelsQuery("")).toEqual([]);
    });
});
