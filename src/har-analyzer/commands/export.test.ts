import { describe, expect, test } from "bun:test";
import { sanitizeEntry } from "@app/har-analyzer/commands/export";
import type { HarEntry } from "@app/har-analyzer/types";
import { SafeJSON } from "@genesiscz/utils/json";

const FAKE_JWT = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.sig-part-abc123";
const FAKE_SESSION = "01604099e599b904607597df62fbbad91d8670fe2f04d8509bcd";

function entryWithCredentials(): HarEntry {
    return {
        startedDateTime: "2026-10-05T08:57:57.000Z",
        time: 10,
        request: {
            method: "GET",
            url: "https://example.test/api/products/all",
            httpVersion: "HTTP/2",
            headers: [
                { name: "Authorization", value: `Bearer ${FAKE_JWT}` },
                { name: "Cookie", value: `TS0106c854=${FAKE_SESSION}; theme=dark` },
            ],
            queryString: [],
            cookies: [{ name: "TS0106c854", value: FAKE_SESSION }],
            headersSize: -1,
            bodySize: -1,
        },
        response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/2",
            headers: [{ name: "Set-Cookie", value: `TS0106c854=${FAKE_SESSION}; Path=/; Secure; HttpOnly` }],
            cookies: [{ name: "TS0106c854", value: FAKE_SESSION }],
            content: { size: 0, mimeType: "application/json" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
    } as HarEntry;
}

describe("export --sanitize", () => {
    test("keeps no part of a bearer token or a session cookie, neither its head nor its tail", () => {
        const text = SafeJSON.stringify(sanitizeEntry(entryWithCredentials(), 0), { strict: true });

        for (const fragment of [
            FAKE_JWT.slice(0, 12),
            FAKE_JWT.slice(-6),
            FAKE_SESSION.slice(0, 12),
            FAKE_SESSION.slice(-6),
        ]) {
            expect(text).not.toContain(fragment);
        }
    });
});
