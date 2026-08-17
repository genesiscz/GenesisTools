/**
 * `redactUrl` is a security boundary: `logger.debug` always reaches the day-stamped log file,
 * so anything this function lets through is written to disk in plaintext. The rule these tests
 * enforce is the strong one — the secret must not appear ANYWHERE in the output — rather than
 * the weak one of checking that "REDACTED" shows up somewhere.
 */
import { describe, expect, test } from "bun:test";
import { getText, redactUrl } from "@app/spotify/lib/io";

const SECRET = "s3cr3t-value";

describe("redactUrl", () => {
    test("redacts a query parameter that names a credential", () => {
        const out = redactUrl(`https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&api_key=${SECRET}`);
        expect(out).not.toContain(SECRET);
        expect(out).toContain("api_key=REDACTED");
        expect(out).toContain("method=artist.gettoptags");
    });

    test("matches the parameter name case-insensitively", () => {
        for (const name of ["API_KEY", "Access-Token", "X-Auth", "clientSecret", "SIGNATURE"]) {
            expect(redactUrl(`https://example.test/?${name}=${SECRET}`)).not.toContain(SECRET);
        }
    });

    test("redacts every copy of a repeated parameter", () => {
        const out = redactUrl(`https://example.test/?token=${SECRET}&token=${SECRET}-two&page=2`);
        expect(out).not.toContain(SECRET);
        expect(out).toContain("page=2");
    });

    test("clears credentials carried in the userinfo", () => {
        const out = redactUrl(`https://someone:${SECRET}@example.test/path`);
        expect(out).not.toContain(SECRET);
        expect(out).not.toContain("someone");
        expect(out).toContain("example.test/path");
    });

    // Where an OAuth implicit flow leaves an access token.
    test("redacts a credential in the fragment", () => {
        const out = redactUrl(`https://example.test/callback#access_token=${SECRET}&state=abc`);
        expect(out).not.toContain(SECRET);
        expect(out).toContain("state=abc");
    });

    test("leaves an ordinary fragment alone", () => {
        expect(redactUrl("https://example.test/docs#installation")).toBe("https://example.test/docs#installation");
    });

    test("drops the query and fragment of a URL that does not parse", () => {
        expect(redactUrl(`/relative/path?api_key=${SECRET}`)).toBe("/relative/path");
        expect(redactUrl(`not a url#token=${SECRET}`)).toBe("not a url");
    });

    // A URL can be malformed for a reason that has nothing to do with its credentials — an
    // invalid host, say — and those sit BEFORE the "?" the fallback keeps.
    test("strips userinfo from a URL that does not parse", () => {
        expect(redactUrl(`https://someone:${SECRET}@%/`)).not.toContain(SECRET);
        expect(redactUrl(`https://someone:${SECRET}@%/path?api_key=${SECRET}`)).not.toContain(SECRET);
        expect(redactUrl(`https://someone:${SECRET}@%/`)).toBe("https://%/");
    });

    // The authority delimiter itself can be malformed, so the fallback cannot anchor on "//",
    // and the credential can contain characters (a slash, say) that no well-formed userinfo
    // would — which is the whole point of the branch that handles URLs that do not parse.
    test("strips userinfo even when the authority is malformed", () => {
        for (const url of [
            `https:/someone:${SECRET}@%/`,
            `https:someone:${SECRET}@%`,
            `someone:${SECRET}@host`,
            `ht!tps://someone:${SECRET}@host/path`,
            `https:/someone:${SECRET}/part@%/`,
            `https://a@b@someone:${SECRET}@%/`,
        ]) {
            expect(redactUrl(url)).not.toContain(SECRET);
        }
    });

    test("leaves a URL with nothing sensitive in it untouched", () => {
        const url = "https://www.last.fm/music/Nocturne+Drive/+tags";
        expect(redactUrl(url)).toBe(url);
    });
});

describe("getText deadline", () => {
    // Without a per-attempt deadline a connection that opens and then stalls parks in
    // `fetch()` forever, so the retry loop underneath is never reached. During an
    // hour-long enrichment crawl that presents as the tool hanging with the last progress
    // line still on screen.
    test("a stalled response aborts and reports rather than hanging", async () => {
        const server = Bun.serve({
            port: 0,
            // Never responds. The deadline is the only thing that can end this.
            fetch: () => new Promise<Response>(() => {}),
        });

        try {
            const started = Date.now();
            const result = await getText(`http://127.0.0.1:${server.port}/stall`, {
                tries: 1,
                timeoutMs: 250,
            });

            expect(result.ok).toBe(false);
            expect(Date.now() - started).toBeLessThan(5000);
        } finally {
            server.stop(true);
        }
    });

    test("a normal response is unaffected by the deadline", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response("hello") });

        try {
            const result = await getText(`http://127.0.0.1:${server.port}/ok`, { timeoutMs: 5000 });
            expect(result).toEqual({ ok: true, body: "hello" });
        } finally {
            server.stop(true);
        }
    });
});
