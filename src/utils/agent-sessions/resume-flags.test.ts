import { describe, expect, test } from "bun:test";
import { carryAgentFlags } from "./resume-flags";

describe("carryAgentFlags", () => {
    test("keeps the agent's own flags with their values, and drops model, resume and wrapper flags", () => {
        expect(
            carryAgentFlags(
                "claude",
                "ffff work --cross-messages --dangerously-skip-permissions -m opus --permission-mode plan -- --resume abc --model=haiku --add-dir=/tmp/x"
            )
        ).toEqual({
            kept: ["--dangerously-skip-permissions", "--permission-mode", "plan", "--add-dir=/tmp/x"],
            dropped: ["--cross-messages", "-m", "--resume", "--model=haiku"],
        });
    });

    test("reads only the last simple command, and quoted values stay one word", () => {
        expect(carryAgentFlags("claude", `cd -- /repo && ffff --append-system-prompt "be brief" --chrome`)).toEqual({
            kept: ["--append-system-prompt", "be brief", "--chrome"],
            dropped: [],
        });
    });

    test("each agent has its own table: -c is codex config, not claude continue", () => {
        expect(carryAgentFlags("codex", "cx -c model_reasoning_effort=high -s danger-full-access").kept).toEqual([
            "-c",
            "model_reasoning_effort=high",
            "-s",
            "danger-full-access",
        ]);
        expect(carryAgentFlags("claude", "ffff -c").dropped).toEqual(["-c"]);
        expect(carryAgentFlags("grok", "g --always-approve -r abc").kept).toEqual(["--always-approve"]);
    });
});
