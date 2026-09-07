import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { grokSubPlugin } from "./index";

/**
 * PR #360 review t14. `grok login` writes `$GROK_HOME/auth.json`, so the home in
 * `env` and the file in `authFile` must name the same directory. They did not
 * when only `--auth-file` was given: the CLI wrote the DEFAULT home while the
 * binder waited on the requested path, and reported "still no credential" after
 * a completed browser round-trip.
 */
function instructionFor(ctx: { home?: string; authFile?: string }) {
    const instruction = grokSubPlugin.accounts?.externalLogin?.({ interactive: false, ...ctx });

    if (!instruction) {
        throw new Error("grok-sub declares no external login");
    }

    return instruction;
}

describe("grok-sub externalLogin keeps GROK_HOME and authFile in agreement", () => {
    test("an auth file with no home dictates the home", () => {
        const authFile = join("/tmp", "invented-grok-home", "auth.json");
        const instruction = instructionFor({ authFile });

        expect(instruction.authFile).toBe(authFile);
        expect(instruction.env?.GROK_HOME).toBe(dirname(authFile));
    });

    test("an explicit home still wins over the auth file's directory", () => {
        const instruction = instructionFor({
            home: "/tmp/invented-home",
            authFile: "/tmp/elsewhere/auth.json",
        });

        expect(instruction.env?.GROK_HOME).toBe("/tmp/invented-home");
        expect(instruction.authFile).toBe("/tmp/elsewhere/auth.json");
    });

    test("a home with no auth file names the file inside it", () => {
        const instruction = instructionFor({ home: "/tmp/invented-home" });

        expect(instruction.env?.GROK_HOME).toBe("/tmp/invented-home");
        expect(instruction.authFile).toBe(join("/tmp/invented-home", "auth.json"));
    });
});
