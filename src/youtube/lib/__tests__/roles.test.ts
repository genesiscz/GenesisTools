import { describe, expect, it } from "bun:test";
import { isPowerRole, roleForEmail } from "@app/youtube/lib/roles";

const powerUsers = [
    { email: "Boss@Example.com", type: "admin" as const },
    { email: "dev@example.com", type: "dev" as const },
];

describe("roleForEmail", () => {
    it("matches emails case-insensitively", () => {
        expect(roleForEmail(powerUsers, "boss@example.com")).toBe("admin");
        expect(roleForEmail(powerUsers, "DEV@EXAMPLE.COM")).toBe("dev");
    });

    it("defaults to user for unlisted emails", () => {
        expect(roleForEmail(powerUsers, "random@example.com")).toBe("user");
        expect(roleForEmail([], "boss@example.com")).toBe("user");
    });
});

describe("isPowerRole", () => {
    it("is true for admin and dev, false for user", () => {
        expect(isPowerRole("admin")).toBe(true);
        expect(isPowerRole("dev")).toBe(true);
        expect(isPowerRole("user")).toBe(false);
    });
});
