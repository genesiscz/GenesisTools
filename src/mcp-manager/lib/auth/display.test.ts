import { describe, expect, test } from "bun:test";
import { describeAuthStatus, formatExpiry } from "./display.ts";

const NOW = Date.UTC(2026, 11, 9, 18, 50, 0);

describe("describeAuthStatus", () => {
    test("live oauth gateway does not dump internal keys", () => {
        const row = describeAuthStatus({
            server: "figma",
            kind: "oauth",
            gateway: true,
            hasAccess: true,
            expired: false,
            expiresAt: NOW + 55 * 60 * 1000,
            now: NOW,
        });

        expect(row.auth).toBe("OAuth, gateway");
        expect(row.token).toBe("live");
        expect(row.needsLogin).toBe(false);
        expect(row.expires).toMatch(/^in 55m \(/);
        expect(row.expires).not.toContain("kind ");
        expect(row.expires).not.toContain("vault ");
        expect(row.expires).not.toContain("T19:46:17");
    });

    test("oauth without a token needs login", () => {
        const row = describeAuthStatus({
            server: "figma",
            kind: "oauth",
            gateway: true,
            hasAccess: false,
            expired: false,
            now: NOW,
        });

        expect(row.token).toBe("missing");
        expect(row.expires).toBe("—");
        expect(row.needsLogin).toBe(true);
    });

    test("expired token", () => {
        const row = describeAuthStatus({
            server: "rohlik",
            kind: "oauth",
            gateway: true,
            hasAccess: true,
            expired: true,
            expiresAt: NOW - 2 * 60 * 60 * 1000,
            now: NOW,
        });

        expect(row.token).toBe("expired");
        expect(row.expires).toMatch(/2h ago \(/);
        expect(row.needsLogin).toBe(true);
    });

    test("stdio with no auth", () => {
        const row = describeAuthStatus({
            server: "blender",
            gateway: false,
            hasAccess: false,
            expired: false,
            now: NOW,
        });

        expect(row.auth).toBe("none");
        expect(row.token).toBe("none");
        expect(row.needsLogin).toBe(false);
    });

    test("long-lived token uses days, not thousands of hours", () => {
        const row = describeAuthStatus({
            server: "figma",
            kind: "oauth",
            gateway: true,
            hasAccess: true,
            expired: false,
            expiresAt: NOW + 90 * 24 * 60 * 60 * 1000,
            now: NOW,
        });

        expect(row.expires).toMatch(/^in 90d \(/);
        expect(row.expires).not.toContain("h ");
    });
});

describe("formatExpiry", () => {
    test("empty", () => {
        expect(formatExpiry(undefined, NOW)).toBe("—");
    });
});
