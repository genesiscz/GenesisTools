import { describe, expect, it } from "bun:test";
import { formatHostsList, parseHostsList } from "./allowed-hosts";

describe("parseHostsList", () => {
    it("splits comma-delimited input, trims, dedupes, and drops empty strings", () => {
        expect(parseHostsList(" myhost.example.com , myhost.example.com , localhost ")).toEqual([
            "myhost.example.com",
            "localhost",
        ]);
    });

    it("drops invalid hostnames", () => {
        expect(parseHostsList("valid.dev, -bad-, ,not valid")).toEqual(["valid.dev"]);
    });
});

describe("formatHostsList", () => {
    it("joins hosts for display", () => {
        expect(formatHostsList(["myhost.example.com", "localhost"])).toBe("myhost.example.com, localhost");
    });
});
