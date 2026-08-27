import { describe, expect, test } from "bun:test";
import { redactArgs } from "./worker";

/**
 * Regression test: PR #330 review t15. `runTurn` logs the invocation with the
 * comment "the day-stamped log gets the shape of the invocation, never its
 * payload", because a prompt can carry credentials or private code.
 *
 * It did not hold. `promptArgs` emits `-p <text>` for an inline prompt while
 * `redactArgs` only looked for the long `--prompt`, so every `tools grok run
 * --prompt "…"` wrote the prompt verbatim into ~/.genesis-tools/logs.
 */
describe("redactArgs", () => {
    test("redacts the inline prompt, which the CLI passes as -p", () => {
        const redacted = redactArgs(["-p", "my api key is sk-live-secret", "--session-id", "s-1"]);

        expect(redacted).not.toContain("my api key is sk-live-secret");
        expect(redacted).toEqual(["-p", "<redacted>", "--session-id", "s-1"]);
    });

    test("redacts both long prompt spellings", () => {
        expect(redactArgs(["--prompt", "secret"])).toEqual(["--prompt", "<redacted>"]);
        expect(redactArgs(["--prompt-file", "/private/brief.md"])).toEqual(["--prompt-file", "<redacted>"]);
    });

    test("leaves the non-payload shape of the invocation readable", () => {
        const redacted = redactArgs(["--resume", "s-1", "--tools", "read_file,list_dir,grep", "-m", "grok-4"]);

        expect(redacted).toEqual(["--resume", "s-1", "--tools", "read_file,list_dir,grep", "-m", "grok-4"]);
    });
});
