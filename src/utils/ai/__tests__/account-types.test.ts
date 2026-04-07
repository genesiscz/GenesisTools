import { describe, expect, it } from "bun:test";
import type { AIAccountEntry, AIAccountTokens, AIProvider } from "../account-types";

describe("account-types", () => {
    describe("AIProvider type", () => {
        it("accepts all valid provider strings", () => {
            const providers: AIProvider[] = [
                "anthropic",
                "anthropic-sub",
                "openai",
                "openai-sub",
                "google",
                "groq",
                "elevenlabs",
                "huggingface",
            ];
            expect(providers).toHaveLength(8);
        });
    });

    describe("AIAccountTokens", () => {
        it("allows all fields optional", () => {
            const tokens: AIAccountTokens = {};
            expect(tokens.apiKey).toBeUndefined();
            expect(tokens.accessToken).toBeUndefined();
            expect(tokens.refreshToken).toBeUndefined();
            expect(tokens.expiresAt).toBeUndefined();
        });

        it("holds API key", () => {
            const tokens: AIAccountTokens = { apiKey: "sk-ant-api03-xxx" };
            expect(tokens.apiKey).toBe("sk-ant-api03-xxx");
        });

        it("holds OAuth tokens with expiry", () => {
            const tokens: AIAccountTokens = {
                accessToken: "sk-ant-oat01-xxx",
                refreshToken: "refresh-xxx",
                expiresAt: Date.now() + 3600_000,
            };
            expect(tokens.accessToken).toBeDefined();
            expect(tokens.refreshToken).toBeDefined();
            expect(tokens.expiresAt).toBeGreaterThan(Date.now());
        });
    });

    describe("AIAccountEntry", () => {
        it("requires name, provider, and tokens", () => {
            const entry: AIAccountEntry = {
                name: "test-account",
                provider: "anthropic-sub",
                tokens: { accessToken: "token-xxx" },
            };
            expect(entry.name).toBe("test-account");
            expect(entry.provider).toBe("anthropic-sub");
            expect(entry.tokens.accessToken).toBe("token-xxx");
        });

        it("supports optional label and apps", () => {
            const entry: AIAccountEntry = {
                name: "my-claude",
                provider: "anthropic-sub",
                tokens: { accessToken: "tok" },
                label: "max 20x",
                apps: ["ask", "claude"],
            };
            expect(entry.label).toBe("max 20x");
            expect(entry.apps).toEqual(["ask", "claude"]);
        });
    });

});
