import { describe, expect, test } from "bun:test";
import { pickPageTarget } from "./cdp.ts";

describe("pickPageTarget", () => {
    test("throws when no tab URL matches instead of returning the first tab", () => {
        const pages = [
            { type: "page", url: "http://localhost:3000/" },
            { type: "page", url: "https://idp.example.com/login" },
        ];

        expect(() => pickPageTarget(pages, { url: "app.example.com" })).toThrow('no tab matching "app.example.com"');
    });

    test("returns the matching tab when the URL substring hits", () => {
        const pages = [
            { type: "page", url: "http://localhost:3000/" },
            { type: "page", url: "https://app.example.com/portal" },
        ];

        expect(pickPageTarget(pages, { url: "app.example.com" }).url).toBe("https://app.example.com/portal");
    });

    test("errors with the port when there is no page at all", () => {
        expect(() => pickPageTarget([], { port: 9222 })).toThrow("no page target on port 9222");
    });
});
