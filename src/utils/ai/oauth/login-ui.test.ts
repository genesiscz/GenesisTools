import { describe, expect, test } from "bun:test";
import { type AuthorizationInteraction, presentAuthorizationUrl, readAuthorizationCode } from "./login-ui";

function interaction(action: "open" | "copy" | "none" | null): AuthorizationInteraction {
    return { chooseUrlAction: async () => action, readCode: async () => "unused" };
}

describe("authorization presentation", () => {
    test.each(["open", "copy", "none"] as const)("performs only the selected %s action", async (action) => {
        const events: string[] = [];
        await presentAuthorizationUrl({
            authUrl: "https://example.com/oauth/authorize",
            provider: "Example",
            interaction: interaction(action),
            openUrl: async (url) => {
                events.push(`open:${url}`);
            },
            copyUrl: async (url) => {
                events.push(`copy:${url}`);
            },
        });
        expect(events).toEqual(action === "none" ? [] : [`${action}:https://example.com/oauth/authorize`]);
    });

    test("cancelling stops before browser or clipboard access", async () => {
        const events: string[] = [];
        await expect(
            presentAuthorizationUrl({
                authUrl: "https://example.com/oauth/authorize",
                provider: "Example",
                interaction: interaction(null),
                openUrl: async () => {
                    events.push("open");
                    throw new Error("unexpected browser");
                },
                copyUrl: async () => {
                    events.push("copy");
                    throw new Error("unexpected clipboard");
                },
            })
        ).rejects.toThrow("Cancelled");
        expect(events).toEqual([]);
    });
});

describe("authorization code input", () => {
    test("normalizes a pasted callback URL", async () => {
        const result = await readAuthorizationCode({
            ...interaction("none"),
            readCode: async () => "https://example.com/callback?code=grant&state=session",
        });
        expect(result).toEqual({ code: "grant#session" });
    });

    test("cancellation remains distinct from an invalid paste", async () => {
        expect(await readAuthorizationCode({ ...interaction("none"), readCode: async () => null })).toBeNull();
        const invalid = await readAuthorizationCode({
            ...interaction("none"),
            readCode: async () => "https://example.com/oauth/authorize?code=true",
        });
        expect(invalid).toHaveProperty("error");
    });

    // xAI's authorize endpoint is `/oauth2/authorize`, OpenAI's is `/oauth/authorize`.
    test.each(["/oauth/authorize", "/oauth2/authorize"])(
        "a pasted %s URL is named as the authorization URL, not as a missing code",
        async (path) => {
            const result = await readAuthorizationCode({
                ...interaction("none"),
                readCode: async () => `https://example.com${path}?client_id=abc&state=session`,
            });

            expect(result).toEqual({ error: expect.stringContaining("authorization URL") });
        }
    );
});
