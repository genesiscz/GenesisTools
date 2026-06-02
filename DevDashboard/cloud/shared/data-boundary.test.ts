import { describe, expect, it } from "bun:test";
import { assertNoKeyMaterial, FORBIDDEN_KEY_FIELDS } from "./data-boundary";

describe("data-boundary", () => {
    it("accepts a device row with a public key only", () => {
        expect(() =>
            assertNoKeyMaterial("devices", {
                id: "d1",
                accountId: "a1",
                label: "Martin's iPhone",
                kind: "phone",
                publicKey: "BASE64PUB==",
                pairedAt: "t",
            }),
        ).not.toThrow();
    });

    it("accepts a managed-subdomain row with public routing only", () => {
        expect(() =>
            assertNoKeyMaterial("managed_subdomains", {
                id: "s1",
                accountId: "a1",
                hostname: "martin.devdashboard.app",
                name: "martin",
                routingTarget: "abc.cfargotunnel.com",
                vendorFronted: true,
                status: "ready",
                createdAt: "t",
            }),
        ).not.toThrow();
    });

    it("rejects any record carrying a forbidden private-key field", () => {
        for (const field of FORBIDDEN_KEY_FIELDS) {
            expect(
                () => assertNoKeyMaterial("devices", { id: "x", [field]: "leak" }),
                `should reject ${field}`,
            ).toThrow(/key material/i);
        }
    });

    it("rejects a field outside the table's allow-list", () => {
        expect(() =>
            assertNoKeyMaterial("accounts", { id: "a", email: "e", name: null, createdAt: "t", sharedSecretSmuggle: "leak" }),
        ).toThrow(/not permitted/i);
    });

    it("returns the record on success so it can be used inline", () => {
        const row = { id: "a", email: "e", name: null, createdAt: "t" };
        expect(assertNoKeyMaterial("accounts", row)).toBe(row);
    });
});
