import { describe, expect, it } from "bun:test";
import { formatHostsList, parseHostsList } from "./allowed-hosts";

describe("parseHostsList", () => {
    it("splits comma-delimited input, trims, dedupes, and drops empty strings", () => {
        expect(parseHostsList(" mac.foltyn.dev , mac.foltyn.dev , localhost ")).toEqual([
            "mac.foltyn.dev",
            "localhost",
        ]);
    });

    it("drops invalid hostnames", () => {
        expect(parseHostsList("valid.dev, -bad-, ,not valid")).toEqual(["valid.dev"]);
    });
});

describe("formatHostsList", () => {
    it("joins hosts for display", () => {
        expect(formatHostsList(["mac.foltyn.dev", "localhost"])).toBe("mac.foltyn.dev, localhost");
    });
});
