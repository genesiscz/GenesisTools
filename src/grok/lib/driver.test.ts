import { expect, test } from "bun:test";
import { DEFAULT_SURFACES } from "@genesiscz/utils/worker/isolation";
import { grokDriver, promptInput } from "./driver";

const spawnInput = (account?: string) => ({
    name: "fixture",
    cwd: "/tmp/fixture",
    prompt: "do the thing",
    surfaces: DEFAULT_SURFACES,
    extras: {},
    ...(account === undefined ? {} : { account }),
});

test("grok refuses --account instead of accepting it and pinning nothing", async () => {
    // The shared spawn offers `-a, --account` to every backend, described as "Account every turn
    // is pinned to". Grok pins an auth FILE, not an account, and the driver never read the field:
    // the flag was accepted and the worker billed whatever the ambient environment resolved to.
    // That is the metered-key surprise `--auth` exists to prevent, so silence is the wrong answer.
    await expect(grokDriver.spawn(spawnInput("work"))).rejects.toThrow(/--account work cannot be honoured/);
    await expect(grokDriver.spawn(spawnInput("work"))).rejects.toThrow(/--auth subscription/);
});

test("the refusal names GROK_AUTH_PATH, so the message says what to do instead of only what failed", async () => {
    await expect(grokDriver.spawn(spawnInput("personal"))).rejects.toThrow(/GROK_AUTH_PATH/);
});

test("a brief given as a file travels as a PATH, not as the whole file in argv", () => {
    // The shared verb layer slurps `--prompt-file` into a string because Claude and Codex need the
    // text. Grok's binary takes the path natively, so forwarding the contents pushed the entire
    // brief through argv under ARG_MAX and made `promptArgs`' `--prompt-file` branch unreachable
    // from the CLI while its tests stayed green.
    expect(promptInput("the whole file contents", "/tmp/brief.md")).toEqual({ promptFile: "/tmp/brief.md" });
});

test("NEGATIVE CONTROL: an inline brief still travels as text", () => {
    expect(promptInput("do the thing", undefined)).toEqual({ prompt: "do the thing" });
    expect(promptInput(undefined, undefined)).toEqual({});
});
