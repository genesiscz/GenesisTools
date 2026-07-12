import { describe, expect, it } from "bun:test";
import { extractServiceToken, parseServiceKeys, requireServiceKey } from "@app/youtube/lib/server/auth";

function makeRequest(init: { auth?: string; url?: string } = {}): Request {
    const headers = new Headers();

    if (init.auth) {
        headers.set("Authorization", init.auth);
    }

    return new Request(init.url ?? "http://localhost:9876/api/v1/videos", { headers });
}

describe("parseServiceKeys", () => {
    it("returns an empty list when unset", () => {
        expect(parseServiceKeys(undefined)).toEqual([]);
        expect(parseServiceKeys("")).toEqual([]);
    });

    it("splits a comma-separated list and trims blanks", () => {
        expect(parseServiceKeys("alice-key, bob-key ,, carol-key")).toEqual(["alice-key", "bob-key", "carol-key"]);
    });
});

describe("extractServiceToken", () => {
    it("reads a Bearer header", () => {
        expect(extractServiceToken(makeRequest({ auth: "Bearer abc123" }))).toBe("abc123");
    });

    it("falls back to the access_token query param (WebSocket handshakes)", () => {
        const req = makeRequest({ url: "http://localhost:9876/api/v1/events?access_token=ws-key" });
        expect(extractServiceToken(req)).toBe("ws-key");
    });

    it("falls back to the key query param", () => {
        const req = makeRequest({ url: "http://localhost:9876/api/v1/events?key=ws-key" });
        expect(extractServiceToken(req)).toBe("ws-key");
    });

    it("returns null when no token is present", () => {
        expect(extractServiceToken(makeRequest())).toBeNull();
    });
});

describe("requireServiceKey", () => {
    it("stays open when no keys are configured", () => {
        expect(requireServiceKey(makeRequest(), [])).toBeNull();
    });

    it("rejects a request with no key when auth is enabled", () => {
        const res = requireServiceKey(makeRequest(), ["secret"]);
        expect(res).not.toBeNull();
        expect(res?.status).toBe(401);
    });

    it("rejects a wrong key", () => {
        const res = requireServiceKey(makeRequest({ auth: "Bearer nope" }), ["secret"]);
        expect(res?.status).toBe(401);
    });

    it("accepts a correct key", () => {
        expect(requireServiceKey(makeRequest({ auth: "Bearer secret" }), ["secret"])).toBeNull();
    });

    it("accepts any key from the per-user list", () => {
        const keys = ["alice-key", "bob-key"];
        expect(requireServiceKey(makeRequest({ auth: "Bearer alice-key" }), keys)).toBeNull();
        expect(requireServiceKey(makeRequest({ auth: "Bearer bob-key" }), keys)).toBeNull();
        expect(requireServiceKey(makeRequest({ auth: "Bearer carol-key" }), keys)?.status).toBe(401);
    });

    it("accepts a key supplied via query param (WebSocket)", () => {
        const req = makeRequest({ url: "http://localhost:9876/api/v1/events?access_token=alice-key" });
        expect(requireServiceKey(req, ["alice-key"])).toBeNull();
    });

    it("matches keys of differing lengths (hash-normalized compare)", () => {
        const keys = ["short", "a-much-longer-service-key-value-0123456789"];
        expect(requireServiceKey(makeRequest({ auth: "Bearer short" }), keys)).toBeNull();
        expect(
            requireServiceKey(makeRequest({ auth: "Bearer a-much-longer-service-key-value-0123456789" }), keys)
        ).toBeNull();
        expect(requireServiceKey(makeRequest({ auth: "Bearer a-much-longer" }), keys)?.status).toBe(401);
    });
});
