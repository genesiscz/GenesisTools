import { afterEach, describe, expect, it } from "bun:test";
import { AIConfig } from "../AIConfig";

describe("AIConfig", () => {
    afterEach(() => {
        AIConfig.invalidate();
    });

    it("load() returns a singleton", async () => {
        const a = await AIConfig.load();
        const b = await AIConfig.load();
        expect(a).toBe(b);
    });

    it("invalidate() clears singleton so next load() creates new instance", async () => {
        const a = await AIConfig.load();
        AIConfig.invalidate();
        const b = await AIConfig.load();
        expect(a).not.toBe(b);
    });

    it("getAppDefaults / setAppDefaults round-trips", async () => {
        const config = await AIConfig.load();

        await config.setAppDefaults("test-app", {
            provider: "ollama",
            model: "llama3",
            temperature: 0.7,
        });

        const defaults = config.getAppDefaults("test-app");
        expect(defaults?.provider).toBe("ollama");
        expect(defaults?.model).toBe("llama3");
        expect(defaults?.temperature).toBe(0.7);

        // Clean up
        await config.setAppDefaults("test-app", {
            provider: undefined,
            model: undefined,
            temperature: undefined,
        });
    });

    it("getTask returns config or default for known tasks", async () => {
        const config = await AIConfig.load();
        const task = config.getTask("transcribe");
        expect(task).toBeDefined();
        expect(task.provider).toBeTruthy();
    });

    it("getAccount returns undefined for non-existent account", async () => {
        const config = await AIConfig.load();
        expect(config.getAccount("does-not-exist-xyz")).toBeUndefined();
    });

    it("getAccountsByProvider returns array", async () => {
        const config = await AIConfig.load();
        const accounts = config.getAccountsByProvider("anthropic-sub");
        expect(Array.isArray(accounts)).toBe(true);
    });

    it("isProviderEnabled returns true for unregistered providers", async () => {
        const config = await AIConfig.load();
        expect(config.isProviderEnabled("nonexistent-provider")).toBe(true);
    });

    it("getDefaultAccount falls back to first account when no context default set", async () => {
        const config = await AIConfig.load();
        const account = config.getDefaultAccount("totally-fake-context");
        const allAccounts = config.getAccountsByProvider("anthropic-sub");

        if (allAccounts.length > 0) {
            expect(account).toBeDefined();
        } else {
            expect(account).toBeUndefined();
        }
    });
});
