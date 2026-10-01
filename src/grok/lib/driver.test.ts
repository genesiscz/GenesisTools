import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SURFACES } from "@genesiscz/utils/worker/isolation";
import { grokDriver, promptInput } from "./driver";
import { turnLogPath } from "./paths";
import type { GrokSessionMeta } from "./store";

const sessionMeta = (name: string, turns: number): GrokSessionMeta => ({
    name,
    sessionId: "00000000-0000-4000-8000-000000000000",
    cwd: "/tmp/fixture",
    workerHome: "/tmp/fixture-home",
    readOnly: false,
    turns,
    createdAt: "2026-10-01T00:00:00.000Z",
});

test("while the first turn runs, the latest turn is that running turn, not a turn 0 with no log", () => {
    // `meta.turns` counts FINISHED turns, so it reads 0 during turn 1. `tools grok read` and `tail`
    // asked for turn0.jsonl and threw "No log for turn 0" while turn1.jsonl was being written.
    const running = sessionMeta("fixture-latest-running", 0);
    const log = turnLogPath(running.name, 1);

    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "");

    expect(grokDriver.latestTurn?.(running)).toBe(1);
});

test("NEGATIVE CONTROL: a finished session's latest turn is its last finished turn", () => {
    expect(grokDriver.latestTurn?.(sessionMeta("fixture-latest-finished", 2))).toBe(2);
    expect(grokDriver.latestTurn?.(sessionMeta("fixture-latest-empty", 0))).toBe(0);
});

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
