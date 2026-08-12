import { describe, expect, test } from "bun:test";
import { parseRedactorFlags, redactHar } from "@app/har-analyzer/core/redactor";
import type { HarEntry, HarFile } from "@app/har-analyzer/types";
import { SafeJSON } from "@genesiscz/utils/json";

const FAKE_JWT = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.sig-part-abc123";

function makeEntry(overrides: {
    request?: Partial<HarEntry["request"]>;
    response?: Partial<HarEntry["response"]>;
}): HarEntry {
    return {
        startedDateTime: "2026-08-12T10:00:00.000Z",
        time: 10,
        request: {
            method: "POST",
            url: "https://example.test/login",
            httpVersion: "HTTP/1.1",
            headers: [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: -1,
            ...(overrides.request ?? {}),
        },
        response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: { size: 0, mimeType: "text/plain" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
            ...(overrides.response ?? {}),
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
    } as HarEntry;
}

function makeHar(entries: HarEntry[]): HarFile {
    return { log: { version: "1.2", creator: { name: "test", version: "0" }, entries } };
}

function redactedText(har: HarFile, index = 0): string {
    return SafeJSON.stringify(har.log.entries[index], { strict: true });
}

describe("redactHar", () => {
    test("redacts password/email/username in JSON request body", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    postData: {
                        mimeType: "application/json",
                        text: SafeJSON.stringify(
                            { username: "martin", password: "hunter2", profile: { email: "a@b.cz" } },
                            { strict: true }
                        ),
                    },
                },
            }),
        ]);

        const { har: result, changes } = redactHar(har);
        const text = redactedText(result);

        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("a@b.cz");
        expect(text).not.toContain('"martin"');
        expect(changes.some((c) => c.kind === "password" && c.location === "request.body $.password")).toBe(true);
        expect(changes.some((c) => c.kind === "email")).toBe(true);
        expect(changes.some((c) => c.kind === "username")).toBe(true);
    });

    test("redacts urlencoded form body (WSO2/CAS login shape)", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    postData: {
                        mimeType: "application/x-www-form-urlencoded",
                        text: "username=martin%40cez.cz&password=Sup3r%2Bt4jn3&sessionDataKey=abc-123&keepMe=on",
                    },
                },
            }),
        ]);

        const text = redactedText(redactHar(har).har);

        expect(text).not.toContain("Sup3r");
        expect(text).not.toContain("martin%40cez.cz");
        expect(text).not.toContain("abc-123");
        expect(text).toContain("keepMe=on");
    });

    test("redacts postData params array", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    postData: {
                        mimeType: "multipart/form-data",
                        params: [
                            { name: "password", value: "tajneheslo" },
                            { name: "note", value: "hello" },
                        ],
                    },
                },
            }),
        ]);

        const text = redactedText(redactHar(har).har);
        expect(text).not.toContain("tajneheslo");
        expect(text).toContain("hello");
    });

    test("redacts tokens in JSON response body and email under any key", () => {
        const har = makeHar([
            makeEntry({
                response: {
                    content: {
                        size: 100,
                        mimeType: "application/json",
                        text: SafeJSON.stringify(
                            {
                                access_token: "opaque-token-value",
                                id_token: FAKE_JWT,
                                sub: "someone@firma.cz",
                                expires_in: 3600,
                            },
                            { strict: true }
                        ),
                    },
                },
            }),
        ]);

        const text = redactedText(redactHar(har).har);
        expect(text).not.toContain("opaque-token-value");
        expect(text).not.toContain(FAKE_JWT);
        expect(text).not.toContain("someone@firma.cz");
        expect(text).toContain("3600");
    });

    test("redacts Authorization header preserving scheme, cookies, set-cookie value only", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    headers: [
                        { name: "Authorization", value: `Bearer ${FAKE_JWT}` },
                        { name: "Cookie", value: "JSESSIONID=deadbeef; theme=dark" },
                        { name: "Accept", value: "application/json" },
                    ],
                    cookies: [{ name: "JSESSIONID", value: "deadbeef" }],
                },
                response: {
                    headers: [{ name: "Set-Cookie", value: "opbs=secret123; Path=/; HttpOnly; Secure" }],
                },
            }),
        ]);

        const text = redactedText(redactHar(har).har);
        expect(text).not.toContain("deadbeef");
        expect(text).not.toContain(FAKE_JWT);
        expect(text).not.toContain("secret123");
        expect(text).toContain("Bearer eyJhbGciOiJS[***]");
        expect(text).toContain("Path=/; HttpOnly; Secure");
        expect(text).toContain("application/json");
    });

    test("redacts sensitive query params in url, queryString array and redirectURL", () => {
        const url = `https://auth.test/authorize?client_id=col&login_hint=martin%40cez.cz&id_token_hint=${FAKE_JWT}`;
        const har = makeHar([
            makeEntry({
                request: {
                    url,
                    queryString: [
                        { name: "client_id", value: "col" },
                        { name: "login_hint", value: "martin@cez.cz" },
                    ],
                },
                response: {
                    status: 302,
                    redirectURL: `https://app.test/cb?code=abc&id_token=${FAKE_JWT}`,
                },
            }),
        ]);

        const text = redactedText(redactHar(har).har);
        expect(text).not.toContain(FAKE_JWT);
        expect(text).not.toContain("martin%40cez.cz");
        expect(text).not.toContain("martin@cez.cz");
        expect(text).toContain("client_id=col");
    });

    test("redacts JWTs in log.pages titles (OAuth logout URLs)", () => {
        const har = makeHar([makeEntry({})]);
        har.log.pages = [
            {
                startedDateTime: "2026-08-12T10:00:00.000Z",
                id: "page_1",
                title: `https://auth.test/oidc/logout?id_token_hint=${FAKE_JWT}&post_logout=https://app.test`,
                pageTimings: {},
            },
        ];

        const { har: result, changes } = redactHar(har);
        const text = SafeJSON.stringify(result, { strict: true });

        expect(text).not.toContain(FAKE_JWT);
        expect(changes.some((c) => c.location.startsWith("log.pages[0]"))).toBe(true);
        expect(redactHar(result).changes).toHaveLength(0);
    });

    test("catch-all removes JWTs from non-standard fields", () => {
        const entry = makeEntry({});
        (entry as unknown as Record<string, unknown>)._initiator = {
            stack: `at https://x.test/app.js token=${FAKE_JWT}`,
        };
        const text = redactedText(redactHar(makeHar([entry])).har);
        expect(text).not.toContain(FAKE_JWT);
    });

    test("negative controls: token_type, error code, HTML contact email, image@2x survive", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    postData: {
                        mimeType: "application/json",
                        text: SafeJSON.stringify({ token_type: "Bearer", code: "USER_NOT_FOUND" }, { strict: true }),
                    },
                },
                response: {
                    content: {
                        size: 100,
                        mimeType: "text/html",
                        text: '<a href="mailto:podpora@cez.cz">podpora@cez.cz</a> <img src="logo@2x.png">',
                    },
                },
            }),
        ]);

        const { har: result, changes } = redactHar(har);
        const text = redactedText(result);

        const body = result.log.entries[0].request.postData?.text ?? "";
        expect(body).toContain('"token_type":"Bearer"');
        expect(body).toContain("USER_NOT_FOUND");
        expect(text).toContain("podpora@cez.cz");
        expect(text).toContain("logo@2x.png");
        expect(changes).toHaveLength(0);
    });

    test("base64 response bodies are skipped and reported", () => {
        const har = makeHar([
            makeEntry({
                response: {
                    content: { size: 10, mimeType: "application/json", text: "aGVsbG8=", encoding: "base64" },
                },
            }),
        ]);

        const { skipped } = redactHar(har);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]).toContain("base64");
    });

    test("idempotent: second pass over redacted output finds zero changes", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    headers: [{ name: "Authorization", value: `Bearer ${FAKE_JWT}` }],
                    postData: {
                        mimeType: "application/json",
                        text: SafeJSON.stringify({ password: "x", email: "a@b.cz" }, { strict: true }),
                    },
                    cookies: [{ name: "sid", value: "s3cret" }],
                },
            }),
        ]);

        const first = redactHar(har);
        expect(first.changes.length).toBeGreaterThan(0);

        const second = redactHar(first.har);
        expect(second.changes).toHaveLength(0);
    });

    test("mask shapes: stars keep length, partial keeps head+tail, emails keep domain", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    postData: {
                        mimeType: "application/json",
                        text: SafeJSON.stringify(
                            { password: "hunter2", access_token: "opaque-token-value", email: "someone@firma.cz" },
                            { strict: true }
                        ),
                    },
                },
            }),
        ]);

        const body = SafeJSON.parse(redactHar(har).har.log.entries[0].request.postData?.text ?? "{}", {
            strict: true,
        }) as Record<string, string>;

        expect(body.password).toBe("*******");
        expect(body.access_token).toBe("opaq[***]alue");
        expect(body.email).toBe("*******@firma.cz");
    });

    test("options: skip leaves the kind untouched, only restricts to listed kinds", () => {
        const makeFixture = () =>
            makeHar([
                makeEntry({
                    request: {
                        cookies: [{ name: "sid", value: "cookievalue123" }],
                        postData: {
                            mimeType: "application/json",
                            text: SafeJSON.stringify({ password: "hunter2", email: "a@b.cz" }, { strict: true }),
                        },
                    },
                }),
            ]);

        const skipped = redactHar(makeFixture(), { skip: ["cookie"] }).har;
        expect(skipped.log.entries[0].request.cookies[0].value).toBe("cookievalue123");
        expect(skipped.log.entries[0].request.postData?.text).not.toContain("hunter2");

        const only = redactHar(makeFixture(), { only: ["password"] }).har;
        expect(only.log.entries[0].request.cookies[0].value).toBe("cookievalue123");
        expect(only.log.entries[0].request.postData?.text).not.toContain("hunter2");
        expect(only.log.entries[0].request.postData?.text).toContain("a@b.cz");
    });

    test("options: style overrides (label, keep)", () => {
        const har = makeHar([
            makeEntry({
                request: {
                    cookies: [{ name: "sid", value: "cookievalue123" }],
                    postData: {
                        mimeType: "application/json",
                        text: SafeJSON.stringify({ password: "hunter2" }, { strict: true }),
                    },
                },
            }),
        ]);

        const { har: result } = redactHar(har, { styles: { password: "label", cookie: "keep" } });
        expect(result.log.entries[0].request.postData?.text).toContain("[REDACTED:password]");
        expect(result.log.entries[0].request.cookies[0].value).toBe("cookievalue123");
    });

    test("parseRedactorFlags validates kinds and styles", () => {
        const good = parseRedactorFlags({ skip: "cookie,email", mask: "password=label,token=stars" });
        expect(good.errors).toHaveLength(0);
        expect(good.options.skip).toEqual(["cookie", "email"]);
        expect(good.options.styles).toEqual({ password: "label", token: "stars" });

        const bad = parseRedactorFlags({ only: "cookie,nonsense", mask: "password=blur" });
        expect(bad.errors).toHaveLength(2);
        expect(bad.options.only).toEqual(["cookie"]);
    });

    test("entry count and non-sensitive structure preserved", () => {
        const har = makeHar([
            makeEntry({}),
            makeEntry({ request: { method: "GET", url: "https://example.test/data?page=2" } }),
        ]);
        const { har: result } = redactHar(har);

        expect(result.log.entries).toHaveLength(2);
        expect(result.log.entries[1].request.url).toBe("https://example.test/data?page=2");
        expect(result.log.entries[1].request.method).toBe("GET");
    });
});
