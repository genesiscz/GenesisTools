import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env/envVariables";

const TRACKED_KEYS = [
    "XAI_API_KEY",
    "X_AI_API_KEY",
    "HUGGINGFACE_TOKEN",
    "HF_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GENESIS_TOOLS_HOME",
] as const;

type TrackedKey = (typeof TRACKED_KEYS)[number];

describe("env", () => {
    let savedEnv: Partial<Record<TrackedKey, string | undefined>> = {};

    beforeEach(() => {
        savedEnv = {};
        for (const key of TRACKED_KEYS) {
            savedEnv[key] = process.env[key];
        }
    });

    afterEach(() => {
        for (const key of TRACKED_KEYS) {
            const value = savedEnv[key];
            if (value !== undefined) {
                env.testing.set(key, value);
            } else {
                env.testing.unset(key);
            }
        }
    });

    it("resolves xAI API key aliases with env key name", () => {
        env.testing.unset("XAI_API_KEY");
        env.testing.set("X_AI_API_KEY", "key-from-underscore");

        expect(env.getXAIApiKey()).toBe("key-from-underscore");
        expect(env.getXAIApiEnvKey()).toBe("X_AI_API_KEY");
        expect(env.x.getApiKey()).toBe("key-from-underscore");
        expect(env.ai.xai.getEnvKey()).toBe("X_AI_API_KEY");
    });

    it("prefers XAI_API_KEY over X_AI_API_KEY", () => {
        env.testing.set("XAI_API_KEY", "canonical");
        env.testing.set("X_AI_API_KEY", "legacy");

        expect(env.getXAIApiEnvKey()).toBe("XAI_API_KEY");
        expect(env.getXAIApiKey()).toBe("canonical");
    });

    it("resolves HuggingFace token aliases", () => {
        env.testing.set("HF_TOKEN", "hf-key");

        expect(env.hf.getKey()).toBe("hf-key");
        expect(env.hf.getEnvKey()).toBe("HF_TOKEN");
    });

    it("keeps Copilot token separate from generic GitHub token", () => {
        env.testing.set("GITHUB_TOKEN", "gho_generic");
        env.testing.set("COPILOT_GITHUB_TOKEN", "gho_copilot");

        expect(env.github.getToken()).toBe("gho_generic");
        expect(env.github.getCopilotToken()).toBe("gho_copilot");
        expect(env.github.getCopilotTokenEnvKey()).toBe("COPILOT_GITHUB_TOKEN");
    });

    it("resolves tools home with fallback to homedir", () => {
        const home = join(tmpdir(), "gt-home");
        env.testing.set("GENESIS_TOOLS_HOME", home);
        expect(env.tools.getHome()).toBe(home);
        expect(env.tools.getHomeEnvKey()).toBe("GENESIS_TOOLS_HOME");
    });

    it("withOverrides restores env after callback", async () => {
        env.testing.set("GENESIS_TOOLS_HOME", "before");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: "during" }, () => {
            expect(env.tools.getHome()).toBe("during");
        });

        expect(env.tools.getHome()).toBe("before");
    });
});
