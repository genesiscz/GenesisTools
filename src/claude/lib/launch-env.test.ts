import { describe, expect, test } from "bun:test";
import { pinnedLaunchEnv, subscriptionTypeOf } from "./launch-env";

describe("pinnedLaunchEnv", () => {
    // Pinned key-by-key: dropping any one of these silently changes how the
    // launched session authenticates or which models `/model` offers.
    test("carries all eight keys", () => {
        const env = pinnedLaunchEnv({ name: "work", label: "max 20x" }, "sk-ant-oat01-token");

        expect(env).toEqual({
            TOOLS_CLAUDE_ACCOUNT: "work",
            TOOLS_CLAUDE_AUTH: "token",
            CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token",
            CLAUDE_CODE_SUBSCRIPTION_TYPE: "max",
            ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
            ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-fable-5[1m]",
            ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Fable 5",
            ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fable 5 · Most capable for hardest and longest-running tasks",
        });
    });

    test("an account with no label still gets a subscription type", () => {
        expect(pinnedLaunchEnv({ name: "work" }, "t").CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe("max");
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
