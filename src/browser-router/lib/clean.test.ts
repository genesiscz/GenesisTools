import { describe, expect, test } from "bun:test";
import { cleanUrl } from "./clean";

describe("cleanUrl", () => {
    test("unwraps an outlook safelink and strips tracking", () => {
        const inner = "https://shop.example/item?id=1&utm_source=mail&fbclid=abc";
        const wrapped = `https://nam.safelinks.protection.outlook.com/x?url=${encodeURIComponent(inner)}`;
        expect(cleanUrl(wrapped)).toBe("https://shop.example/item?id=1");
    });

    test("strips utm parameters and leaves the rest", () => {
        expect(cleanUrl("https://example.com/a?utm_source=x&id=2")).toBe("https://example.com/a?id=2");
    });
});

describe("cleanUrl redirectors", () => {
    test("a look-alike domain is not unwrapped, a real subdomain is", () => {
        const inner = "https://shop.example/a";
        expect(cleanUrl(`https://notslack.com/r?url=${encodeURIComponent(inner)}`)).toBe(
            `https://notslack.com/r?url=${encodeURIComponent(inner)}`
        );
        expect(cleanUrl(`https://app.slack.com/r?url=${encodeURIComponent(inner)}`)).toBe(inner);
    });

    test("the inner URL is decoded once, so an encoded & stays in its value", () => {
        const inner = "https://shop.example/search?q=a%26b&page=2";
        const wrapped = `https://nam.safelinks.protection.outlook.com/x?url=${encodeURIComponent(inner)}`;
        expect(cleanUrl(wrapped)).toBe(inner);

        const percent = "https://shop.example/off?rate=50%25";
        expect(cleanUrl(`https://nam.safelinks.protection.outlook.com/x?url=${encodeURIComponent(percent)}`)).toBe(
            percent
        );
    });

    test("a redirector inside a redirector is unwrapped to the final page, as the native router does", () => {
        const final = "https://shop.example/item?id=1&utm_source=mail";
        const google = `https://www.google.com/url?q=${encodeURIComponent(final)}`;
        const safelink = `https://nam.safelinks.protection.outlook.com/x?url=${encodeURIComponent(google)}`;

        expect(cleanUrl(safelink)).toBe("https://shop.example/item?id=1");
    });
});
