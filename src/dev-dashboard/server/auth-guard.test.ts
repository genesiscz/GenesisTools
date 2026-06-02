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

    it("allows a /share/<slug> GET without auth", () => {
        const d = decideApiAuth({ method: "GET", pathname: "/share/tok", headers: {}, provision });
        expect(d.decision).toBe("allow");
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
