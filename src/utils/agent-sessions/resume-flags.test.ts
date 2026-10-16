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
            unresolved: [],
        });
    });

    test("reads only the last simple command, and quoted values stay one word", () => {
        expect(carryAgentFlags("claude", `cd -- /repo && ffff --append-system-prompt "be brief" --chrome`)).toEqual({
            kept: ["--append-system-prompt", "be brief", "--chrome"],
            dropped: [],
            unresolved: [],
        });
    });

    test.each([
        {
            kind: "claude" as const,
            command: 'ffff --add-dir "$PROJECT_DIR" --chrome',
            flag: "--add-dir $PROJECT_DIR",
            kept: ["--chrome"],
        },
        {
            kind: "claude" as const,
            command: 'ffff --settings="${SETTINGS}" --chrome',
            flag: "--settings=${SETTINGS}",
            kept: ["--chrome"],
        },
        {
            kind: "claude" as const,
            command: 'ffff --mcp-config "$(printf config)" --chrome',
            flag: "--mcp-config $(printf config)",
            kept: ["--chrome"],
        },
        {
            kind: "codex" as const,
            command: 'cx -c "model_reasoning_effort=$EFFORT" --search',
            flag: "-c model_reasoning_effort=$EFFORT",
            kept: ["--search"],
        },
    ])("declines unresolved values in $command", ({ kind, command, flag, kept }) => {
        const flags = carryAgentFlags(kind, command);
        expect(flags.kept).toEqual([...kept]);
        expect(flags).toMatchObject({ unresolved: [flag] });
    });

    test("single-quoted and escaped dollar signs are literal values, so they survive", () => {
        expect(carryAgentFlags("claude", String.raw`ffff --add-dir '$PROJECT_DIR' --settings=\$SETTINGS`).kept).toEqual(
            ["--add-dir", "$PROJECT_DIR", "--settings=$SETTINGS"]
        );
    });

    test.each([";", "&&", "||", "|", "&"])("quoted %s is an argument, never a command separator", (value) => {
        expect(carryAgentFlags("claude", `ffff --append-system-prompt '${value}' --chrome`).kept).toEqual([
            "--append-system-prompt",
            value,
            "--chrome",
        ]);
    });

    test.each(["&&", "||", ";", "|", "&"])("glued %s still separates simple commands", (operator) => {
        expect(carryAgentFlags("claude", `echo --no-chrome /repo${operator}ffff --chrome`).kept).toEqual(["--chrome"]);
    });

    test("escaped separators stay literal, and comment flags are never carried", () => {
        expect(
            carryAgentFlags("claude", String.raw`ffff --append-system-prompt \; --chrome # --no-chrome`).kept
        ).toEqual(["--append-system-prompt", ";", "--chrome"]);
    });

    test("operators inside a trailing substitution do not select its inner command", () => {
        const flags = carryAgentFlags("claude", 'ffff --chrome --mcp-config "$(printf a; printf b)"');
        expect(flags.kept).toEqual(["--chrome"]);
        expect(flags.unresolved).toEqual(["--mcp-config $(printf a; printf b)"]);
    });

    test.each([
        '"/opt/launcher" --permission-mode plan --chrome',
        '"/opt/my launcher" --permission-mode plan --chrome',
        "'/opt/my launcher' --permission-mode plan --chrome",
        'cd /repo&&"/opt/my launcher" --permission-mode plan --chrome',
        'echo --no-chrome|"/opt/my launcher" --permission-mode plan --chrome',
        '"/opt/my launcher" "--permission-mode" "plan" "--chrome"',
        'echo --no-chrome&&"/opt/my launcher" "--permission-mode" "plan" "--chrome"',
    ])("keeps plan restrictions after a quoted launcher in %s", (command) => {
        expect(carryAgentFlags("claude", command)).toEqual({
            kept: ["--permission-mode", "plan", "--chrome"],
            dropped: [],
            unresolved: [],
        });
    });

    test("a quoted launcher without arguments carries no flags", () => {
        expect(carryAgentFlags("claude", '"/opt/my launcher"')).toEqual({ kept: [], dropped: [], unresolved: [] });
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
