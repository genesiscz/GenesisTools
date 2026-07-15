import { describe, expect, test } from "bun:test";
import { isLiveChannel, parseChannelsQuery } from "./channels";

describe("parseChannelsQuery", () => {
    test("splits, dedupes, drops invalid", () => {
        expect(parseChannelsQuery("ports,pulse,ports,nope")).toEqual(["ports", "pulse"]);
    });

    test("boards and daemon", () => {
        expect(isLiveChannel("boards:foo")).toBe(true);
        expect(isLiveChannel("daemon:/tmp/x.log")).toBe(true);
        expect(isLiveChannel("boards:")).toBe(false);
        expect(isLiveChannel("daemon:")).toBe(false);
    });

    test("empty", () => {
        expect(parseChannelsQuery(null)).toEqual([]);
        expect(parseChannelsQuery("")).toEqual([]);
    });
});
