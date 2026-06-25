import { describe, expect, it } from "bun:test";
import { isPublicShareRequest } from "@app/dev-dashboard/lib/share-auth";

describe("isPublicShareRequest", () => {
    it("allows GET and HEAD on /share/<slug>", () => {
        expect(isPublicShareRequest("GET", "/share/tok")).toBe(true);
        expect(isPublicShareRequest("HEAD", "/share/tok")).toBe(true);
    });

    it("allows optional trailing slash", () => {
        expect(isPublicShareRequest("GET", "/share/tok/")).toBe(true);
        expect(isPublicShareRequest("HEAD", "/share/tok/")).toBe(true);
    });

    it("rejects nested paths and other methods", () => {
        expect(isPublicShareRequest("GET", "/share/tok/extra")).toBe(false);
        expect(isPublicShareRequest("POST", "/share/tok")).toBe(false);
        expect(isPublicShareRequest("GET", "/api/share/tok")).toBe(false);
    });
});
