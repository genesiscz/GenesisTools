import { afterEach, describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { type GrokEmbedDeps, grokEmbedSpawn, isAccountlessProbe, runGrokEmbed } from "./embed";
import { assertGrokLeaderAuthSafe, grokLauncher } from "./launcher";

/**
 * `tools grok run <account> --name x --cwd y` is grok's SECOND spawn door: the legacy headless
 * worker route, kept alive behind `preflight`. The driver's `--account` refusal only closed the
 * first one, so an account named here was discarded in silence and the turn billed whatever
 * `GROK_AUTH_PATH` / `XAI_API_KEY` happened to resolve to — worse than the flag it replaced,
 * because a name that exists nowhere was accepted too.
 */

const workerFlags = { name: "rv4-probe", cwd: "/tmp" };

test("a shared leader refuses a vault-only grant before any credential is materialised", () => {
    expect(() => assertGrokLeaderAuthSafe({ leaderSocket: "/fixture/leader.sock" })).toThrow(/vault-only/);
    expect(() => assertGrokLeaderAuthSafe({ passthrough: ["--leader"] })).toThrow(/vault-only/);
    expect(() =>
        assertGrokLeaderAuthSafe({ leaderSocket: "/fixture/leader.sock", authFile: "/fixture/auth.json" })
    ).not.toThrow();
    expect(() => assertGrokLeaderAuthSafe({})).not.toThrow();
});

test("the TUI launcher refuses a vault-only leader before opening its grant", async () => {
    await expect(
        grokLauncher.launch({
            account: {
                id: "acc_work",
                name: "work",
                provider: "grok-sub",
                enabled: true,
                billing: { mode: "subscription" },
                credentials: {},
                useEnvApiKey: false,
            },
            nativeResume: false,
            continueLast: false,
            cwd: "/fixture",
            passthrough: [],
            flags: { leaderSocket: "/fixture/leader.sock" },
        })
    ).rejects.toThrow(/vault-only/);
});

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

describe("tools grok embed", () => {
    const fixtureAccount: AccountEntry = {
        id: "acc_work",
        name: "work",
        provider: "grok-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
    };
    const acpArgv = ["--permission-mode", "default", "agent", "stdio"];

    function harness(overrides: Partial<GrokEmbedDeps> = {}) {
        const calls: string[] = [];
        const spawned: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
        const deps: GrokEmbedDeps = {
            resolveBinary: () => "/fixture/bin/grok",
            pickAccount: async (requested) => {
                calls.push(`pick:${requested}`);
                return fixtureAccount;
            },
            launchAuth: async () => {
                calls.push("auth");
                return {
                    authPath: "/fixture/grant.json",
                    home: "/fixture/home",
                    release: async () => calls.push("release"),
                };
            },
            runChild: async (input) => {
                calls.push("child");
                spawned.push(input);
                return 7;
            },
            ...overrides,
        };
        return { calls, spawned, deps };
    }

    afterEach(() => {
        process.exitCode = 0;
    });

    test("the child gets the host argv byte for byte and the account's login environment", async () => {
        await env.testing.withOverrides({ XAI_API_KEY: "xai-fixture", GROK_CODE_XAI_API_KEY: "xai-fixture" }, () => {
            const spawn = grokEmbedSpawn({
                binary: "/fixture/bin/grok",
                argv: ["agent", "--always-approve", "stdio"],
                account: "work",
                authPath: "/fixture/grant.json",
                home: "/fixture/home",
            });

            expect(spawn.cmd).toEqual(["/fixture/bin/grok", "agent", "--always-approve", "stdio"]);
            expect(spawn.env.GROK_HOME).toBe("/fixture/home");
            expect(spawn.env.GROK_AUTH_PATH).toBe("/fixture/grant.json");
            expect(spawn.env.TOOLS_GROK_ACCOUNT).toBe("work");
            expect(spawn.env.XAI_API_KEY).toBeUndefined();
            expect(spawn.env.GROK_CODE_XAI_API_KEY).toBeUndefined();
        });
    });

    test("a named account runs the child, sets its exit code and releases the grant after it exits", async () => {
        const { calls, spawned, deps } = harness();

        await runGrokEmbed({ request: { kind: "account", name: "work" }, argv: acpArgv }, deps);

        expect(calls).toEqual(["pick:work", "auth", "child", "release"]);
        expect(spawned[0]?.argv).toEqual(["/fixture/bin/grok", ...acpArgv]);
        expect(process.exitCode).toBe(7);
    });

    test("auto goes to the shared picker, and a child that throws still releases the grant", async () => {
        const { calls, deps } = harness({
            runChild: async () => {
                throw new Error("spawn failed");
            },
        });

        await expect(runGrokEmbed({ request: { kind: "auto" }, argv: acpArgv }, deps)).rejects.toThrow("spawn failed");
        expect(calls).toEqual(["pick:auto", "auth", "release"]);
    });

    test("a proxy request is refused before any account or credential is touched", async () => {
        const { calls, deps } = harness();

        await runGrokEmbed({ request: { kind: "proxy", target: "work/xai" }, argv: acpArgv }, deps);

        expect(calls).toEqual([]);
        expect(process.exitCode).toBe(2);
    });

    test("an account the picker refuses launches nothing", async () => {
        const { calls, deps } = harness({ pickAccount: async () => null });

        await runGrokEmbed({ request: { kind: "account", name: "nope" }, argv: acpArgv }, deps);

        expect(calls).toEqual([]);
        expect(process.exitCode).toBe(1);
    });

    test("--version runs without an account; NEGATIVE CONTROL: version inside a longer argv still picks one", async () => {
        const probe = harness();
        await runGrokEmbed({ request: { kind: "account", name: "work" }, argv: ["--version"] }, probe.deps);
        expect(probe.calls).toEqual(["child"]);
        expect(probe.spawned[0]?.argv).toEqual(["/fixture/bin/grok", "--version"]);

        expect(isAccountlessProbe(["models"])).toBe(false);
        expect(isAccountlessProbe(["agent", "--version"])).toBe(false);
    });
});
