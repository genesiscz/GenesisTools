import { expect, test } from "bun:test";
import { grokLauncher } from "./launcher";

/**
 * `tools grok run <account> --name x --cwd y` is grok's SECOND spawn door: the legacy headless
 * worker route, kept alive behind `preflight`. The driver's `--account` refusal only closed the
 * first one, so an account named here was discarded in silence and the turn billed whatever
 * `GROK_AUTH_PATH` / `XAI_API_KEY` happened to resolve to — worse than the flag it replaced,
 * because a name that exists nowhere was accepted too.
 */

const workerFlags = { name: "rv4-probe", cwd: "/tmp" };

test("the legacy worker door refuses a positional account instead of discarding it", async () => {
    await expect(
        grokLauncher.preflight?.({ flags: workerFlags, passthrough: [], account: "definitely-no-such-account-xyz" })
    ).rejects.toThrow(/cannot be honoured/);

    await expect(grokLauncher.preflight?.({ flags: workerFlags, passthrough: [], account: "work" })).rejects.toThrow(
        /GROK_AUTH_PATH/
    );
});

test("NEGATIVE CONTROL: the same door with no account still reaches the worker", async () => {
    // The refusal must not swallow the route. With no account the call goes on to `runSession`
    // and dies on the missing brief, which is the pre-existing behaviour of this door.
    await expect(grokLauncher.preflight?.({ flags: workerFlags, passthrough: [] })).rejects.toThrow(
        /A prompt is required/
    );
});

test("NEGATIVE CONTROL: an account on the TUI door is not refused, because grok CAN open a TUI as one", async () => {
    // Without `--name` this is `tools grok run <account>`, the interactive TUI, where the account
    // is honoured by `launch()`. `preflight` must let it through.
    await expect(grokLauncher.preflight?.({ flags: {}, passthrough: [], account: "work" })).resolves.toBeUndefined();
});
