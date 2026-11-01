import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { blockVerdict, detectChallenge } from "./lib/challenge";
import { FetchBlockedError, Fetcher, FetchHttpError } from "./lib/fetcher";
import { extractJsonLd, parsePrice } from "./lib/jsonld";
import { fetchUrl } from "./lib/read";
import type { HttpTransport, TransportName, TransportRequest, TransportResponse } from "./lib/types";

const PROSE = "Readable prose sits in this paragraph, long enough to count as content, with commas and detail.";

function html(body: string, head = "<title>Shop page</title>"): string {
    return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function response(body: string, status = 200, headers: Record<string, string> = {}): TransportResponse {
    return { status, headers, body };
}

/** An in-process transport answering from a table by URL; records what it was asked. */
function fakeTransport(
    name: TransportName,
    answers: Record<string, TransportResponse>
): HttpTransport & {
    seen: TransportRequest[];
} {
    const seen: TransportRequest[] = [];
    return {
        name,
        seen,
        send: async (request) => {
            seen.push(request);
            const answer = answers[request.url];
            if (!answer) {
                throw new Error(`fake ${name}: no answer for ${request.url}`);
            }

            return answer;
        },
        close: async () => {},
    };
}

const CF_CHALLENGE = response(
    html(
        "<script>window._cf_chl_opt={cType:'managed'};</script><script src=\"/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1\"></script>",
        "<title>Kontrola zabezpečení</title>"
    ),
    403,
    { "cf-mitigated": "challenge", server: "cloudflare" }
);

describe("challenge detection", () => {
    test("a Cloudflare challenge is recognised by header, by body marker, and by its localized title", () => {
        expect(detectChallenge(CF_CHALLENGE)).toMatchObject({ vendor: "cloudflare", challenge: true });
        expect(detectChallenge(response(html("<script>window._cf_chl_opt={}</script>"), 200))).toMatchObject({
            vendor: "cloudflare",
            signal: "body _cf_chl_opt",
        });
        expect(
            detectChallenge(response(html("", "<title>Just a moment...</title>"), 503, { server: "cloudflare" }))
        ).toMatchObject({ vendor: "cloudflare", signal: 'title "just a moment..."' });
        expect(detectChallenge(response(html("", "<title>Checking security</title>"), 403))).toMatchObject({
            vendor: "unknown",
            challenge: true,
        });
    });

    test("Akamai, DataDome and PerimeterX pages are recognised", () => {
        expect(detectChallenge(response(html('<div id="sec-if-cpt-container"></div>')))?.vendor).toBe("akamai");
        expect(
            detectChallenge(
                response(html("<p>Reference #18.abc123.1700000000.deadbeef</p>", "<title>Access Denied</title>"), 403)
            )?.vendor
        ).toBe("akamai");
        expect(
            detectChallenge(response(html('<iframe src="https://geo.captcha-delivery.com/c"></iframe>')))?.vendor
        ).toBe("datadome");
        expect(detectChallenge(response(html('<div id="px-captcha"></div>')))?.vendor).toBe("perimeterx");
    });

    test("a normal page with Cloudflare's injected bot script is not a challenge", () => {
        const passed = response(
            html(`<main><p>${PROSE}</p></main><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`),
            200,
            { server: "cloudflare" }
        );

        expect(detectChallenge(passed)).toBeNull();
        expect(blockVerdict(passed)).toBeNull();
    });

    test("a bare 403/429/503 is a refusal without a challenge; a 404 is neither", () => {
        expect(blockVerdict(response("nope", 429))).toEqual({
            vendor: "unknown",
            signal: "HTTP 429",
            challenge: false,
        });
        expect(blockVerdict(response("gone", 404))).toBeNull();
    });
});

const PRODUCT_LD = {
    "@context": "https://schema.org",
    "@graph": [
        { "@type": "Organization", name: "Example Market" },
        {
            "@type": "BreadcrumbList",
            itemListElement: [
                { "@type": "ListItem", position: 2, name: "Gadgets", item: "https://shop.example/gadgets" },
                { "@type": "ListItem", position: 1, item: { "@id": "https://shop.example/", name: "Home" } },
            ],
        },
        {
            "@type": "Product",
            name: "Widget 3000",
            brand: { "@type": "Brand", name: "Acme" },
            sku: "W3K",
            gtin13: "0000000000017",
            image: [{ "@type": "ImageObject", contentUrl: "https://img.example/w.jpg" }, "https://img.example/w2.jpg"],
            aggregateRating: { "@type": "AggregateRating", ratingValue: "93", bestRating: "100", reviewCount: "7" },
            additionalProperty: [{ "@type": "PropertyValue", name: "Colour", value: "red" }],
            offers: {
                "@type": "AggregateOffer",
                lowPrice: "7990",
                highPrice: "9647.33",
                priceCurrency: "CZK",
                offerCount: "2",
                offers: [
                    {
                        "@type": "Offer",
                        price: "7990",
                        priceCurrency: "CZK",
                        availability: "https://schema.org/InStock",
                        itemCondition: "https://schema.org/NewCondition",
                        seller: { "@type": "Organization", name: "Shop One" },
                    },
                    {
                        "@type": "Offer",
                        priceSpecification: {
                            "@type": "UnitPriceSpecification",
                            price: "9647.33",
                            priceCurrency: "CZK",
                        },
                        availability: "http://schema.org/OutOfStock",
                        seller: "Shop Two",
                    },
                ],
            },
        },
    ],
};

describe("JSON-LD extraction", () => {
    test("a Product with an AggregateOffer yields every offer with seller, price, currency and availability", () => {
        const page = html(`<script type="application/ld+json">${SafeJSON.stringify(PRODUCT_LD)}</script>`);
        const data = extractJsonLd(page);

        expect(data.blocks).toBe(1);
        expect(data.parseErrors).toBe(0);
        expect(data.products).toHaveLength(1);
        const [product] = data.products;
        expect(product).toMatchObject({
            type: "Product",
            name: "Widget 3000",
            brand: "Acme",
            sku: "W3K",
            gtin: "0000000000017",
            images: ["https://img.example/w.jpg", "https://img.example/w2.jpg"],
            rating: { value: 93, best: 100, reviewCount: 7 },
            priceRange: { low: 7990, high: 9647.33, currency: "CZK", offerCount: 2 },
            properties: [{ name: "Colour", value: "red" }],
        });
        expect(product.offers).toEqual([
            {
                seller: "Shop One",
                price: 7990,
                currency: "CZK",
                availability: "InStock",
                condition: "NewCondition",
                url: null,
            },
            {
                seller: "Shop Two",
                price: 9647.33,
                currency: "CZK",
                availability: "OutOfStock",
                condition: null,
                url: null,
            },
        ]);
        expect(data.breadcrumbs).toEqual([
            [
                { position: 1, name: "Home", url: "https://shop.example/" },
                { position: 2, name: "Gadgets", url: "https://shop.example/gadgets" },
            ],
        ]);
        expect(data.other).toEqual([{ type: "Organization", name: "Example Market" }]);
    });

    test("single offers get a computed price range; broken blocks are counted, not thrown", () => {
        const single = {
            "@type": "Product",
            name: "Lamp",
            offers: { "@type": "Offer", price: 12.5, priceCurrency: "EUR" },
        };
        const page = html(
            `<script type='application/ld+json'>${SafeJSON.stringify(single)}</script>` +
                '<script type="application/ld+json">{"@type": broken</script>'
        );
        const data = extractJsonLd(page);

        expect(data.blocks).toBe(2);
        expect(data.parseErrors).toBe(1);
        expect(data.products[0].priceRange).toEqual({ low: 12.5, high: 12.5, currency: "EUR", offerCount: 1 });
    });

    test("prices in local formats parse", () => {
        expect(parsePrice("7 990,50")).toBe(7990.5);
        expect(parsePrice("1,234.50")).toBe(1234.5);
        expect(parsePrice("1.234,50 Kč")).toBe(1234.5);
        expect(parsePrice("free")).toBeNull();
    });
});

describe("Fetcher transports", () => {
    const url = "https://shop.example/item";
    const PAGE = response(html(`<main><h1>Item</h1><p>${PROSE}</p></main>`));

    test("auto escalates to chrome once on a challenge and says so", async () => {
        const plain = fakeTransport("plain", { [url]: CF_CHALLENGE });
        const chrome = fakeTransport("chrome", { [url]: PAGE });
        const fetcher = new Fetcher({ transports: { plain, chrome } });

        const result = await fetchUrl(fetcher, { url, mode: "markdown", transport: "auto" });

        expect(result.transport).toBe("chrome");
        expect(result.escalation).toMatchObject({ from: "plain", status: 403, reason: { vendor: "cloudflare" } });
        expect(result.text).toStartWith("# Item");
        expect(plain.seen).toHaveLength(1);
        expect(chrome.seen).toHaveLength(1);
    });

    test("auto stays on plain for a normal page", async () => {
        const plain = fakeTransport("plain", { [url]: PAGE });
        const chrome = fakeTransport("chrome", {});
        const result = await fetchUrl(new Fetcher({ transports: { plain, chrome } }), { url, mode: "raw" });

        expect(result.transport).toBe("plain");
        expect(result.escalation).toBeUndefined();
        expect(chrome.seen).toHaveLength(0);
    });

    test("a challenge the transport did not pass is an error naming every attempt, never content", async () => {
        const plainOnly = new Fetcher({ transports: { plain: fakeTransport("plain", { [url]: CF_CHALLENGE }) } });
        const plainError = await fetchUrl(plainOnly, { url, mode: "markdown", transport: "plain" }).catch((e) => e);
        expect(plainError).toBeInstanceOf(FetchBlockedError);
        expect(plainError.message).toContain("Cloudflare challenge page");
        expect(plainError.message).toContain('Retry with transport "auto"');

        const both = new Fetcher({
            transports: {
                plain: fakeTransport("plain", { [url]: CF_CHALLENGE }),
                chrome: fakeTransport("chrome", { [url]: CF_CHALLENGE }),
            },
        });
        const bothError = await fetchUrl(both, { url, mode: "jsonld", transport: "auto" }).catch((e) => e);
        expect(bothError).toBeInstanceOf(FetchBlockedError);
        expect(bothError.attempts.map((a: { transport: string }) => a.transport)).toEqual(["plain", "chrome"]);
        expect(bothError.message).toContain("Even the Chrome fingerprint was refused");
    });

    test("redirects are followed with caller headers kept to the origin; a 404 is an HTTP error", async () => {
        const plain = fakeTransport("plain", {
            "https://shop.example/old": response("", 301, { location: "https://cdn.example/new" }),
            "https://cdn.example/new": PAGE,
            "https://shop.example/missing": response("gone", 404),
        });
        const fetcher = new Fetcher({ transports: { plain } });
        const result = await fetchUrl(fetcher, {
            url: "https://shop.example/old",
            mode: "raw",
            transport: "plain",
            headers: { cookie: "a=b" },
        });

        expect(result.source).toBe("https://cdn.example/new");
        expect(plain.seen.map((request) => request.headers)).toEqual([{ cookie: "a=b" }, {}]);
        await expect(
            fetchUrl(fetcher, { url: "https://shop.example/missing", mode: "raw", transport: "plain" })
        ).rejects.toBeInstanceOf(FetchHttpError);
    });
});
