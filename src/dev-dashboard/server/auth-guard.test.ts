import { describe, expect, it } from "bun:test";
import { createBasicAuthCredentials, makeBasicAuthHeader } from "@app/dev-dashboard/lib/auth";
import { decideApiAuth } from "@app/dev-dashboard/server/auth-guard";

const { auth } = createBasicAuthCredentials({ username: "u", password: "p" });
const provision = { auth, generatedPassword: null };

describe("decideApiAuth", () => {
    it("allows a genuine loopback origin (header set by proxy)", () => {
        const d = decideApiAuth({
            method: "GET",
            pathname: "/api/system/pulse",
            headers: { "x-dd-local-origin": "1" },
            provision,
        });
        expect(d.decision).toBe("allow");
    });

    it("rejects foreign browser mutations before the loopback grant", () => {
        const d = decideApiAuth({
            method: "POST",
            pathname: "/api/ttyd/spawn",
            requestUrl: "http://localhost:3042/api/ttyd/spawn",
            headers: {
                host: "localhost:3042",
                origin: "https://attacker.test",
                "sec-fetch-site": "cross-site",
                "x-dd-local-origin": "1",
            },
            provision,
        });
        expect(d.decision).toBe("deny");
    });

    it("keeps same-origin browser and absent-Origin native mutations working", () => {
        expect(
            decideApiAuth({
                method: "POST",
                pathname: "/api/ttyd/spawn",
                requestUrl: "http://localhost:3042/api/ttyd/spawn",
                headers: {
                    host: "localhost:3042",
                    origin: "http://localhost:3042",
                    "sec-fetch-site": "same-origin",
                    "x-dd-local-origin": "1",
                },
                provision,
            }).decision
        ).toBe("allow");
        expect(
            decideApiAuth({
                method: "POST",
                pathname: "/api/ttyd/spawn",
                requestUrl: "http://localhost:3042/api/ttyd/spawn",
                headers: { host: "localhost:3042", "x-dd-local-origin": "1" },
                provision,
            }).decision
        ).toBe("allow");
    });

    it("allows a /share/<slug> GET without auth", () => {
        const d = decideApiAuth({ method: "GET", pathname: "/share/tok", headers: {}, provision });
        expect(d.decision).toBe("allow");
    });

    it("allows HEAD and trailing-slash share URLs without auth", () => {
        expect(decideApiAuth({ method: "HEAD", pathname: "/share/tok", headers: {}, provision }).decision).toBe(
            "allow"
        );
        expect(decideApiAuth({ method: "GET", pathname: "/share/tok/", headers: {}, provision }).decision).toBe(
            "allow"
        );
    });

    it("allows + mints a cookie for a valid Basic header", () => {
        const d = decideApiAuth({
            method: "GET",
            pathname: "/api/system/pulse",
            headers: { authorization: makeBasicAuthHeader({ username: "u", password: "p" }) },
            provision,
        });
        expect(d.decision).toBe("allow");
        expect(d.setCookie).toBeString();
    });

    it("denies a missing/invalid credential", () => {
        const d = decideApiAuth({ method: "GET", pathname: "/api/system/pulse", headers: {}, provision });
        expect(d.decision).toBe("deny");
    });
});
