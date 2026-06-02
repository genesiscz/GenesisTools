import { describe, expect, it } from "bun:test";
import { decodeJwt, describeClaimTime, humanizeDelta } from "./lib/jwt-core";

// Public jwt.io sample token (HS256). Decoding needs no secret.
const SAMPLE =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("decodeJwt", () => {
    it("decodes header and payload of a valid token", () => {
        const result = decodeJwt(SAMPLE);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            throw new Error("expected ok");
        }

        expect(result.header).toEqual({ alg: "HS256", typ: "JWT" });
        expect(result.payload).toEqual({ sub: "1234567890", name: "John Doe", iat: 1516239022 });
        expect(result.signature).toBe("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    });

    it("rejects a token without exactly three segments", () => {
        const result = decodeJwt("aaa.bbb");
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error("expected error");
        }

        expect(result.error).toContain("3 dot-separated segments");
        expect(result.error).toContain("got 2");
    });

    it("rejects an empty segment", () => {
        const result = decodeJwt("aaa..ccc");
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error("expected error");
        }

        expect(result.error).toContain("3 dot-separated segments");
    });

    it("rejects a segment that is not valid JSON", () => {
        // "###" is not valid base64url → decodes to garbage that is not JSON.
        const result = decodeJwt("###.###.sig");
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error("expected error");
        }

        expect(result.error.toLowerCase()).toContain("header");
    });
});

const NOW_MS = 1_700_000_000_000; // fixed injected "now"

describe("humanizeDelta", () => {
    it("formats the largest non-zero unit, floored", () => {
        expect(humanizeDelta(23 * 60_000)).toBe("23m");
        expect(humanizeDelta(2 * 3_600_000)).toBe("2h");
        expect(humanizeDelta(90_000)).toBe("1m");
        expect(humanizeDelta(45_000)).toBe("45s");
        expect(humanizeDelta(3 * 86_400_000)).toBe("3d");
        expect(humanizeDelta(0)).toBe("0s");
    });
});

describe("describeClaimTime", () => {
    it("describes a future exp as 'expires in <Δ>'", () => {
        const expSeconds = (NOW_MS + 23 * 60_000) / 1000;
        expect(describeClaimTime("exp", expSeconds, NOW_MS)).toBe("expires in 23m");
    });

    it("describes a past exp as 'EXPIRED <Δ> ago'", () => {
        const expSeconds = (NOW_MS - 2 * 3_600_000) / 1000;
        expect(describeClaimTime("exp", expSeconds, NOW_MS)).toBe("EXPIRED 2h ago");
    });

    it("describes a past iat as '<Δ> ago'", () => {
        const iatSeconds = (NOW_MS - 5 * 60_000) / 1000;
        expect(describeClaimTime("iat", iatSeconds, NOW_MS)).toBe("5m ago");
    });

    it("describes a future nbf as 'in <Δ>'", () => {
        const nbfSeconds = (NOW_MS + 10 * 60_000) / 1000;
        expect(describeClaimTime("nbf", nbfSeconds, NOW_MS)).toBe("in 10m");
    });
});
