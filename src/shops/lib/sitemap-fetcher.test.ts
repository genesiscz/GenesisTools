import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { walkSitemap } from "@app/shops/lib/sitemap-fetcher";

interface MockedFetchScope {
    install(routes: Record<string, MockResponse>): void;
    restore(): void;
}

interface MockResponse {
    body: string | Buffer;
    status?: number;
    headers?: Record<string, string>;
}

const realFetch = globalThis.fetch;

function withMockedFetch(): MockedFetchScope {
    let routes: Record<string, MockResponse> = {};
    return {
        install(rs) {
            routes = rs;
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
                const route = routes[url];
                if (!route) {
                    return new Response("not mocked", { status: 404 });
                }

                // Bun's Response accepts Buffer/Uint8Array directly but the
                // @types/node Response signature is stricter — cast through
                // unknown for this test mock only.
                const responseBody = (route.body instanceof Buffer
                    ? new Uint8Array(route.body.buffer, route.body.byteOffset, route.body.byteLength)
                    : route.body) as unknown as BodyInit;
                return new Response(responseBody, {
                    status: route.status ?? 200,
                    headers: route.headers ?? { "content-type": "application/xml" },
                });
            }) as typeof fetch;
        },
        restore() {
            globalThis.fetch = realFetch;
            routes = {};
        },
    };
}

const scope = withMockedFetch();

beforeAll(() => {
    scope.install({});
});

afterAll(() => {
    scope.restore();
});

describe("walkSitemap", () => {
    it("yields URLs from a flat <urlset>", async () => {
        scope.install({
            "https://example.com/sitemap.xml": {
                body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/p1</loc></url>
<url><loc>https://example.com/p2</loc></url>
<url><loc>https://example.com/p3</loc></url>
</urlset>`,
            },
        });

        const out: string[] = [];
        for await (const u of walkSitemap("https://example.com/sitemap.xml")) {
            out.push(u);
        }

        expect(out).toEqual(["https://example.com/p1", "https://example.com/p2", "https://example.com/p3"]);
    });

    it("recurses through <sitemapindex> children", async () => {
        scope.install({
            "https://example.com/sitemap.xml": {
                body: `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://example.com/products_01.xml</loc></sitemap>
<sitemap><loc>https://example.com/products_02.xml</loc></sitemap>
</sitemapindex>`,
            },
            "https://example.com/products_01.xml": {
                body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/pA</loc></url>
<url><loc>https://example.com/pB</loc></url>
</urlset>`,
            },
            "https://example.com/products_02.xml": {
                body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/pC</loc></url>
</urlset>`,
            },
        });

        const out: string[] = [];
        for await (const u of walkSitemap("https://example.com/sitemap.xml")) {
            out.push(u);
        }

        expect(out.sort()).toEqual(["https://example.com/pA", "https://example.com/pB", "https://example.com/pC"]);
    });

    it("decompresses .xml.gz children transparently", async () => {
        const childXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/p-gz-1</loc></url>
<url><loc>https://example.com/p-gz-2</loc></url>
</urlset>`;
        scope.install({
            "https://example.com/sitemap.xml": {
                body: `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://example.com/products.xml.gz</loc></sitemap>
</sitemapindex>`,
            },
            "https://example.com/products.xml.gz": {
                body: gzipSync(Buffer.from(childXml)),
                headers: { "content-type": "application/gzip" },
            },
        });

        const out: string[] = [];
        for await (const u of walkSitemap("https://example.com/sitemap.xml")) {
            out.push(u);
        }

        expect(out.sort()).toEqual(["https://example.com/p-gz-1", "https://example.com/p-gz-2"]);
    });

    it("respects childFilter to skip non-product shards", async () => {
        scope.install({
            "https://example.com/sitemap.xml": {
                body: `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://example.com/products_01.xml</loc></sitemap>
<sitemap><loc>https://example.com/categories.xml</loc></sitemap>
</sitemapindex>`,
            },
            "https://example.com/products_01.xml": {
                body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/pP</loc></url></urlset>`,
            },
            "https://example.com/categories.xml": {
                body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/cC</loc></url></urlset>`,
            },
        });

        const out: string[] = [];
        for await (const u of walkSitemap("https://example.com/sitemap.xml", {
            childFilter: (u) => u.includes("products_"),
        })) {
            out.push(u);
        }

        expect(out).toEqual(["https://example.com/pP"]);
    });

    it("respects urlFilter on leaves", async () => {
        scope.install({
            "https://example.com/sitemap.xml": {
                body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/p1</loc></url>
<url><loc>https://example.com/c2</loc></url>
<url><loc>https://example.com/p3</loc></url>
</urlset>`,
            },
        });

        const out: string[] = [];
        for await (const u of walkSitemap("https://example.com/sitemap.xml", {
            urlFilter: (u) => u.includes("/p"),
        })) {
            out.push(u);
        }

        expect(out).toEqual(["https://example.com/p1", "https://example.com/p3"]);
    });

    it("stops at maxUrls", async () => {
        scope.install({
            "https://example.com/sitemap.xml": {
                body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/p1</loc></url>
<url><loc>https://example.com/p2</loc></url>
<url><loc>https://example.com/p3</loc></url>
<url><loc>https://example.com/p4</loc></url>
</urlset>`,
            },
        });

        const out: string[] = [];
        for await (const u of walkSitemap("https://example.com/sitemap.xml", { maxUrls: 2 })) {
            out.push(u);
        }

        expect(out).toEqual(["https://example.com/p1", "https://example.com/p2"]);
    });

    it("ignores 404 child sitemaps without crashing the walk", async () => {
        scope.install({
            "https://example.com/sitemap.xml": {
                body: `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://example.com/missing.xml</loc></sitemap>
<sitemap><loc>https://example.com/ok.xml</loc></sitemap>
</sitemapindex>`,
            },
            "https://example.com/missing.xml": { body: "", status: 404 },
            "https://example.com/ok.xml": {
                body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/p-ok</loc></url></urlset>`,
            },
        });

        const out: string[] = [];
        for await (const u of walkSitemap("https://example.com/sitemap.xml")) {
            out.push(u);
        }

        expect(out).toEqual(["https://example.com/p-ok"]);
    });
});
