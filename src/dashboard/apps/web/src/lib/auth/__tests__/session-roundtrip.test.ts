import { env } from "@app/utils/env";
import { sessionEncryption } from "@workos/authkit-session";
import { describe, expect, test } from "vitest";
import { encryptSession, type Session } from "../../auth-server";

// Load-bearing assumption for the whole auth model: a session sealed by our
// iron-session `encryptSession` MUST be readable by AuthKit's iron-webcrypto
// `unsealData` (same WORKOS_COOKIE_PASSWORD). If this breaks, every
// password-signed-in user gets 401 from requireUserId() and login is dead.
describe("iron-session ⇄ AuthKit session encryption", () => {
    test("encryptSession output roundtrips through AuthKit's unsealData", async () => {
        const cookiePassword = "test-cookie-password-at-least-32-chars-long";
        env.testing.set("WORKOS_COOKIE_PASSWORD", cookiePassword);

        const session = {
            accessToken: "access-token",
            refreshToken: "refresh-token",
            user: {
                id: "user_123",
                email: "person@example.com",
                emailVerified: true,
                firstName: "Test",
                lastName: "User",
                profilePictureUrl: null,
                object: "user",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
            },
        } as unknown as Session;

        const encrypted = await encryptSession(session);
        const decrypted = await sessionEncryption.unsealData(encrypted, {
            password: cookiePassword,
        });

        expect(decrypted).toEqual(session);
    });
});
