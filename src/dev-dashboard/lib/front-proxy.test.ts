import { describe, expect, test } from "bun:test";
import type { DashboardAuthProvision } from "@app/dev-dashboard/config";
import {
    createBasicAuthCredentials,
    issueSessionToken,
    LOCAL_ORIGIN_HEADER,
    makeBasicAuthHeader,
} from "@app/dev-dashboard/lib/auth";
import { decideProxyAuth, isLongLivedProxiedStream, isLoopbackOnlyOrigin } from "@app/dev-dashboard/lib/front-proxy";

// Security regression net for the ttyd/WS auth gate. The front-proxy serves
// /ttyd/* and every WS upgrade BEFORE the Vite auth middleware, so this gate is
// the only thing between LAN/tunnel and a writable shell. If any of this code
// changes, these tests must still hold or the bypass is back.

function reqWith(headers: Record<string, string>): Request {
    return new Request("http://dev-dashboard.test/ttyd/x/", { headers });
}

const { auth, password } = createBasicAuthCredentials({ username: "martin", password: "s3cret" });
const provision: DashboardAuthProvision = { auth, generatedPassword: null };

describe("isLoopbackOnlyOrigin — locality comes from socket + Host only", () => {
    test("genuine loopback hits are local", () => {
        expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost:3042" }), "127.0.0.1")).toBe(true);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "[::1]:3042" }), "::1")).toBe(true);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "127.0.0.1" }), "::ffff:127.0.0.1")).toBe(true);
    });

    test("non-loopback socket is never local, whatever the Host says", () => {
        expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost:3042" }), "192.168.0.15")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "127.0.0.1" }), "10.0.0.2")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost" }), undefined)).toBe(false);
    });

    test("Cloudflare/forwarded edge headers exclude the tunnel even from loopback", () => {
        for (const h of ["cf-ray", "cf-connecting-ip", "cf-visitor", "cdn-loop", "x-forwarded-for"]) {
            expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost", [h]: "v" }), "127.0.0.1")).toBe(false);
        }
    });

    test("non-localhost Host from loopback (tunnel/LAN names) is not local", () => {
        expect(isLoopbackOnlyOrigin(reqWith({ host: "myhost.example.com" }), "127.0.0.1")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "192.168.0.15:3042" }), "127.0.0.1")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "evil.example" }), "127.0.0.1")).toBe(false);
    });

    test("an inbound x-dd-local-origin header NEVER confers locality (anti-spoof)", () => {
        expect(
            isLoopbackOnlyOrigin(reqWith({ host: "192.168.0.15", [LOCAL_ORIGIN_HEADER]: "1" }), "192.168.0.15")
        ).toBe(false);
    });
});

describe("decideProxyAuth — the ttyd/WS gate matrix", () => {
    test("loopback origin is allowed with no credentials", () => {
        expect(decideProxyAuth({ req: reqWith({}), isLocal: true, provision })).toBe("allow");
    });

    test("remote (LAN/tunnel) with no credentials is denied", () => {
        expect(decideProxyAuth({ req: reqWith({}), isLocal: false, provision })).toBe("deny");
    });

    test("a forged x-dd-local-origin header does NOT bypass the proxy gate", () => {
        expect(decideProxyAuth({ req: reqWith({ [LOCAL_ORIGIN_HEADER]: "1" }), isLocal: false, provision })).toBe(
            "deny"
        );
    });

    test("valid Basic auth is allowed remotely", () => {
        const req = reqWith({ authorization: makeBasicAuthHeader({ username: "martin", password }) });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("allow");
    });

    test("wrong Basic auth is denied", () => {
        const req = reqWith({ authorization: makeBasicAuthHeader({ username: "martin", password: "nope" }) });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("deny");
    });

    test("a valid session cookie is allowed remotely", () => {
        const req = reqWith({ cookie: `dd_session=${issueSessionToken(auth)}` });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("allow");
    });

    test("a tampered session cookie is denied", () => {
        const req = reqWith({ cookie: `dd_session=${issueSessionToken(auth)}TAMPER` });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("deny");
    });

    test("a future-dated session cookie is denied", () => {
        const realNow = Date.now;
        Date.now = () => realNow() + 60_000;
        const futureToken = issueSessionToken(auth);
        Date.now = realNow;

        const req = reqWith({ cookie: `dd_session=${futureToken}` });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("deny");
    });

    test("auth disabled by config allows everything", () => {
        const disabled: DashboardAuthProvision = {
            auth: { enabled: false, username: "martin" },
            generatedPassword: null,
        };
        expect(decideProxyAuth({ req: reqWith({}), isLocal: false, provision: disabled })).toBe("allow");
    });

    test("incomplete auth config reports unconfigured (deny-equivalent → 503)", () => {
        const incomplete: DashboardAuthProvision = {
            auth: { enabled: true, username: "martin" },
            generatedPassword: null,
        };
        expect(decideProxyAuth({ req: reqWith({}), isLocal: false, provision: incomplete })).toBe("unconfigured");
    });
});

describe("LOCAL_ORIGIN_HEADER invariant", () => {
    test("is the exact lowercased name both proxy and middleware rely on", () => {
        // A careless rename here is exactly the desync that turns the loopback
        // trust into a fail-open auth bypass — pin the value.
        expect(LOCAL_ORIGIN_HEADER).toBe("x-dd-local-origin");
        expect(LOCAL_ORIGIN_HEADER).toBe(LOCAL_ORIGIN_HEADER.toLowerCase());
    });
});

describe("isLongLivedProxiedStream", () => {
    test("matches QA SSE route only", () => {
        expect(isLongLivedProxiedStream("/api/qa/stream")).toBe(true);
        expect(isLongLivedProxiedStream("/api/qa/log")).toBe(false);
    });
});
