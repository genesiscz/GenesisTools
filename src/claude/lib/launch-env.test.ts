import { describe, expect, test } from "bun:test";
import { pinnedLaunchEnv, subscriptionTypeOf } from "./launch-env";

describe("pinnedLaunchEnv", () => {
    // Pinned key-by-key: dropping any one of these silently changes how the
    // launched session authenticates or which models `/model` offers.
    test("carries all eight keys", () => {
        const env = pinnedLaunchEnv({ name: "work", label: "max 20x" }, { value: "sk-ant-oat01-token" });

        expect(env).toEqual({
            TOOLS_CLAUDE_ACCOUNT: "work",
            TOOLS_CLAUDE_AUTH: "token",
            CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token",
            CLAUDE_CODE_SUBSCRIPTION_TYPE: "max",
            ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-2",
            ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-fable-5-2[1m]",
            ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Fable 5.2",
            ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fable 5.2 · Most capable for hardest and longest-running tasks",
        });
    });

    test("an account with no label still gets a subscription type", () => {
        expect(pinnedLaunchEnv({ name: "work" }, { value: "t" }).CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe("max");
    });

    // Without the variable Claude Code treats the token as inference-only and refuses Code Mode, because it cannot
    // read the organization policy; with it, a token minted with the profile scope passes that check.
    test("names the token's scopes for Claude Code when the grant is known", () => {
        const env = pinnedLaunchEnv({ name: "work" }, { value: "t", scopes: ["user:inference", "user:profile"] });

        expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe("user:inference user:profile");
    });

    // A plan name makes Claude Code class the login as a personal plan and skip the policy fetch, so Code Mode still
    // refused with the scopes set (2.1.328, 2026-11-19). An inference-only token keeps it for the [1m] switch.
    test("leaves the plan name out for a token that reads the profile, and keeps it for an inference-only one", () => {
        const profile = pinnedLaunchEnv(
            { name: "work", label: "max 20x" },
            { value: "t", scopes: ["user:inference", "user:profile"] }
        );
        const inference = pinnedLaunchEnv(
            { name: "work", label: "max 20x" },
            { value: "t", scopes: ["user:inference"] }
        );

        expect(profile).not.toHaveProperty("CLAUDE_CODE_SUBSCRIPTION_TYPE");
        expect(inference.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe("max");
    });

    test("leaves the scopes out for a token whose grant is unknown", () => {
        expect(pinnedLaunchEnv({ name: "work" }, { value: "t" })).not.toHaveProperty("CLAUDE_CODE_OAUTH_SCOPES");
        expect(pinnedLaunchEnv({ name: "work" }, { value: "t", scopes: [] })).not.toHaveProperty(
            "CLAUDE_CODE_OAUTH_SCOPES"
        );
    });
});

describe("subscriptionTypeOf", () => {
    test("takes the first word of the label", () => {
        expect(subscriptionTypeOf({ label: "pro annual" })).toBe("pro");
    });

    test("defaults to max", () => {
        expect(subscriptionTypeOf({})).toBe("max");
    });
});
