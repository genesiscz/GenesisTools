import {
    _resetOutboundLookupForTest,
    _setOutboundLookupForTest,
    OutboundUrlPolicyError,
} from "@genesiscz/utils/net/outbound-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicUrlMetadata } from "./fetch-metadata";
import { extractHtmlMetadata } from "./metadata";

afterEach(() => {
    _resetOutboundLookupForTest();
});

describe("extractHtmlMetadata", () => {
    it("extracts <title> tag", () => {
        const html = "<html><head><title>My Page &amp; More</title></head></html>";
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.title).toBe("My Page & More");
    });

    it("prefers og:title over <title>", () => {
        const html = `
      <html><head>
        <title>Fallback Title</title>
        <meta property="og:title" content="OG Title &lt;cool&gt;" />
      </head></html>`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.title).toBe("OG Title <cool>");
    });

    it("extracts meta description", () => {
        const html = `<meta name="description" content="A great &quot;article&quot;" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.description).toBe('A great "article"');
    });

    it("prefers og:description over meta description", () => {
        const html = `
      <meta name="description" content="Plain desc" />
      <meta property="og:description" content="OG desc &#39;quoted&#39;" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.description).toBe("OG desc 'quoted'");
    });

    it("extracts favicon from <link rel=icon>", () => {
        const html = `<link rel="icon" href="/favicon.ico" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.faviconUrl).toBe("https://example.com/favicon.ico");
    });

    it("extracts shortcut icon", () => {
        const html = `<link rel="shortcut icon" href="https://cdn.example.com/icon.png" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.faviconUrl).toBe("https://cdn.example.com/icon.png");
    });

    it("falls back to /favicon.ico when no link tag present", () => {
        const result = extractHtmlMetadata("<html></html>", "https://example.com");
        expect(result.faviconUrl).toBe("https://example.com/favicon.ico");
    });

    it("resolves relative favicon with path", () => {
        const html = `<link rel="icon" href="../img/fav.png" />`;
        const result = extractHtmlMetadata(html, "https://example.com/blog/post");
        expect(result.faviconUrl).toBe("https://example.com/img/fav.png");
    });

    it("decodes numeric HTML entities in title", () => {
        const html = "<title>Test &#8212; dash &#x2019;apostrophe&#x2019;</title>";
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.title).toBe("Test — dash ’apostrophe’");
    });

    it("returns empty strings when html has no usable content", () => {
        const result = extractHtmlMetadata("", "https://example.com");
        expect(result.title).toBe("");
        expect(result.description).toBe("");
        expect(result.faviconUrl).toBe("https://example.com/favicon.ico");
    });
});

describe("fetchPublicUrlMetadata outbound policy", () => {
    it("rejects private IPv6 and mapped-loopback literals before the request sink", async () => {
        _setOutboundLookupForTest(async () => [{ address: "93.184.216.34" }]);
        const request = vi.fn(async () => new Response("<title>should not run</title>"));

        for (const target of ["http://[::1]:3042/", "http://[::ffff:127.0.0.1]:3042/", "http://[fd00::1]/"]) {
            await expect(fetchPublicUrlMetadata({ target, request })).rejects.toThrow(OutboundUrlPolicyError);
        }
        expect(request).not.toHaveBeenCalled();
    });

    it("rejects a public-looking name when any resolved address is private", async () => {
        _setOutboundLookupForTest(async () => [{ address: "93.184.216.34" }, { address: "10.0.0.8" }]);
        const request = vi.fn(async () => new Response("<title>should not run</title>"));

        await expect(fetchPublicUrlMetadata({ target: "https://mixed.example/page", request })).rejects.toThrow(
            /private address 10\.0\.0\.8/
        );
        expect(request).not.toHaveBeenCalled();
    });

    it("revalidates redirects and keeps the request pinned to the approved address", async () => {
        let lookups = 0;
        _setOutboundLookupForTest(async () => {
            lookups += 1;
            return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1" }];
        });
        const request = vi.fn(async ({ address }: { address: string }) => {
            expect(address).toBe("93.184.216.34");
            return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
        });

        await expect(fetchPublicUrlMetadata({ target: "https://public.example/page", request })).rejects.toThrow(
            OutboundUrlPolicyError
        );
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("fetches and parses a normal public page", async () => {
        _setOutboundLookupForTest(async () => [{ address: "93.184.216.34" }]);
        const request = vi.fn(async ({ url, address }: { url: URL; address: string }) => {
            expect(url.hostname).toBe("public.example");
            expect(address).toBe("93.184.216.34");
            return new Response('<title>Public page</title><meta name="description" content="Normal">', {
                status: 200,
            });
        });

        const result = await fetchPublicUrlMetadata({ target: "https://public.example/page", request });
        expect(result).toMatchObject({ title: "Public page", description: "Normal" });
        expect(request).toHaveBeenCalledTimes(1);
    });
});
