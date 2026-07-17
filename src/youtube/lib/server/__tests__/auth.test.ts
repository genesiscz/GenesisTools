import { describe, expect, it } from "bun:test";
import { env } from "@app/utils/env";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import {
    extractServiceToken,
    parseServiceKeys,
    requireServiceKey,
    requireUser,
    resolveServiceKeys,
} from "@app/youtube/lib/server/auth";

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

describe("resolveServiceKeys — fail closed on garbage (t19)", () => {
    it("keeps open mode when the value is unset (localhost dev)", () => {
        expect(resolveServiceKeys(undefined)).toEqual([]);
    });

    it("returns the parsed keys for a valid list", () => {
        expect(resolveServiceKeys("k1,k2")).toEqual(["k1", "k2"]);
    });

    it("throws for a commas-only value instead of silently opening the API", () => {
        expect(() => resolveServiceKeys(",,,")).toThrow(/no valid service keys/);
    });

    it("throws for a value that is all separators and whitespace", () => {
        expect(() => resolveServiceKeys(", ,\t,")).toThrow(/no valid service keys/);
    });
});

describe("YOUTUBE_SERVICE_KEY env → guard path stays closed on garbage", () => {
    it("commas-only env: the server refuses to start (never falls back to open mode)", async () => {
        await env.testing.withOverrides({ YOUTUBE_SERVICE_KEY: ",,," }, () => {
            const raw = env.youtube.getServiceKey();
            expect(raw).toBe(",,,");
            expect(() => resolveServiceKeys(raw)).toThrow(/no valid service keys/);
        });
    });

    it("empty / whitespace-only env normalizes to 'no key configured' (open mode by design)", async () => {
        await env.testing.withOverrides({ YOUTUBE_SERVICE_KEY: "   " }, () => {
            expect(env.youtube.getServiceKey()).toBeUndefined();
            expect(resolveServiceKeys(env.youtube.getServiceKey())).toEqual([]);
        });
    });
});

describe("requireServiceKey with user tokens", () => {
    it("accepts a valid ytu_ user token when keys are configured", () => {
        const db = new YoutubeDatabase(":memory:");
        const user = db.createUser({ email: "a@example.com", passwordHash: "h", apiToken: "ytu_valid" });
        const req = new Request("http://localhost/api/v1/videos", {
            headers: { Authorization: "Bearer ytu_valid" },
        });

        expect(user.id).toBeGreaterThan(0);
        expect(requireServiceKey(req, ["sk-real"], db)).toBeNull();
        db.close();
    });

    it("still rejects unknown ytu_ tokens", () => {
        const db = new YoutubeDatabase(":memory:");
        const req = new Request("http://localhost/api/v1/videos", {
            headers: { Authorization: "Bearer ytu_bogus" },
        });
        const res = requireServiceKey(req, ["sk-real"], db);

        expect(res?.status).toBe(401);
        db.close();
    });
});

describe("requireUser typed 401", () => {
    it("returns code login_required in the 401 body", async () => {
        const db = new YoutubeDatabase(":memory:");
        const url = new URL("http://localhost/api/v1/users/me");
        const result = requireUser(new Request(url), url, db);

        expect(result instanceof Response).toBe(true);
        const body = (await (result as Response).json()) as { error: string; code?: string };

        expect(body.error).toBe("login required");
        expect(body.code).toBe("login_required");
        db.close();
    });
});
