import { describe, expect, test } from "bun:test";
import { cleanUrl } from "./clean";
import { defaultRouterConfig, route } from "./route";
import { CLEAN_CASES } from "./testing/clean-cases";

describe("cleanUrl", () => {
    for (const row of CLEAN_CASES) {
        test(row.name, () => {
            expect(cleanUrl(row.input)).toBe(row.output);
        });
    }

    test("the router forwards the cleaned link, and `clean: false` forwards it as clicked", () => {
        const dirty = "https://shop.example/a?utm_source=mail&id=2";

        expect(route(dirty, defaultRouterConfig()).url).toBe("https://shop.example/a?id=2");
        expect(route(dirty, { ...defaultRouterConfig(), clean: false }).url).toBe(dirty);
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
