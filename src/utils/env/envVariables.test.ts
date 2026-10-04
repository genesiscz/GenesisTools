import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env/envVariables";

const TRACKED_KEYS = [
    "XAI_API_KEY",
    "X_AI_API_KEY",
    "HUGGINGFACE_TOKEN",
    "HF_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GENESIS_TOOLS_HOME",
] as const;

type TrackedKey = (typeof TRACKED_KEYS)[number];

describe("env", () => {
    let savedEnv: Partial<Record<TrackedKey, string | undefined>> = {};

    beforeEach(() => {
        savedEnv = {};
        for (const key of TRACKED_KEYS) {
            savedEnv[key] = process.env[key];
        }
    });

    afterEach(() => {
        for (const key of TRACKED_KEYS) {
            const value = savedEnv[key];
            if (value !== undefined) {
                env.testing.set(key, value);
            } else {
                env.testing.unset(key);
            }
        }
    });

    it("resolves xAI API key aliases with env key name", () => {
        env.testing.unset("XAI_API_KEY");
        env.testing.set("X_AI_API_KEY", "key-from-underscore");

        expect(env.getXAIApiKey()).toBe("key-from-underscore");
        expect(env.getXAIApiEnvKey()).toBe("X_AI_API_KEY");
        expect(env.x.getApiKey()).toBe("key-from-underscore");
        expect(env.ai.xai.getEnvKey()).toBe("X_AI_API_KEY");
    });

    it("prefers XAI_API_KEY over X_AI_API_KEY", () => {
        env.testing.set("XAI_API_KEY", "canonical");
        env.testing.set("X_AI_API_KEY", "legacy");

        expect(env.getXAIApiEnvKey()).toBe("XAI_API_KEY");
        expect(env.getXAIApiKey()).toBe("canonical");
    });

    it("resolves HuggingFace token aliases", () => {
        env.testing.set("HF_TOKEN", "hf-key");

        expect(env.hf.getKey()).toBe("hf-key");
        expect(env.hf.getEnvKey()).toBe("HF_TOKEN");
    });

    it("keeps Copilot token separate from generic GitHub token", () => {
        env.testing.set("GITHUB_TOKEN", "gho_generic");
        env.testing.set("COPILOT_GITHUB_TOKEN", "gho_copilot");

        expect(env.github.getToken()).toBe("gho_generic");
        expect(env.github.getCopilotToken()).toBe("gho_copilot");
        expect(env.github.getCopilotTokenEnvKey()).toBe("COPILOT_GITHUB_TOKEN");
    });

    it("withoutProxy strips proxy keys from the spawn env", () => {
        const previous = env.get("HTTPS_PROXY");
        env.testing.set("HTTPS_PROXY", "socks5h://127.0.0.1:9");

        try {
            const spawnEnv = env.withoutProxy({ INIT_CWD: "/tmp" });
            expect(spawnEnv.HTTPS_PROXY).toBeUndefined();
            expect(spawnEnv.https_proxy).toBeUndefined();
            expect(spawnEnv.INIT_CWD).toBe("/tmp");
        } finally {
            if (previous === undefined) {
                env.testing.unset("HTTPS_PROXY");
            } else {
                env.testing.set("HTTPS_PROXY", previous);
            }
        }
    });

    // Regression test: Fable judge J10 — a production override (artifact build's NODE_ENV) must not
    // undo a variable that something else in the process set while it ran.
    it("withScoped restores only the keys it set", async () => {
        await env.withScoped({ NODE_ENV: "production" }, () => {
            env.testing.set("GT_SCOPED_PROBE", "kept");
        });

        try {
            expect(env.get("GT_SCOPED_PROBE")).toBe("kept");
        } finally {
            env.testing.unset("GT_SCOPED_PROBE");
        }
    });

    it("withScoped applies the override inside and puts the previous value back after", async () => {
        await env.testing.withOverrides({ NODE_ENV: "development" }, async () => {
            let inside: string | undefined;
            await env.withScoped({ NODE_ENV: "production" }, () => {
                inside = env.get("NODE_ENV");
            });

            expect(inside).toBe("production");
            expect(env.get("NODE_ENV")).toBe("development");
        });
    });

    // Regression test: PR #456 review — two overlapping scopes on one key each saved and restored on
    // their own, so the first to finish pulled the value out from under the second, and the last one
    // left the first one's override in place for the rest of the process
    it("withScoped runs overlapping scopes on the same key one after the other", async () => {
        const key = "GT_SCOPED_ORDER_PROBE";
        const seen: string[] = [];
        let openFirst = (): void => undefined;
        let openSecond = (): void => undefined;
        const firstGate = new Promise<void>((resolve) => {
            openFirst = resolve;
        });
        const secondGate = new Promise<void>((resolve) => {
            openSecond = resolve;
        });

        const first = env.withScoped({ [key]: "first" }, async () => {
            await firstGate;
            seen.push(`first:${env.get(key)}`);
        });
        const second = env.withScoped({ [key]: "second" }, async () => {
            seen.push(`second-start:${env.get(key)}`);
            await secondGate;
            seen.push(`second-end:${env.get(key)}`);
        });

        await Bun.sleep(0);
        openFirst();
        await first;
        openSecond();
        await second;

        expect(seen).toEqual(["first:first", "second-start:second", "second-end:second"]);
        expect(env.get(key)).toBeUndefined();
    });

    // Concurrent artifact builds all set NODE_ENV=production: they must not wait for each other,
    // and the caller's value comes back only after the last one finishes
    it("withScoped runs overlapping scopes with the same value together, and restores after the last", async () => {
        const key = "GT_SCOPED_SHARE_PROBE";
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        const first = env.withScoped({ [key]: "production" }, () => gate);
        let secondSaw: string | undefined;
        const second = env.withScoped({ [key]: "production" }, () => {
            secondSaw = env.get(key);
        });

        await Bun.sleep(0);

        expect(secondSaw).toBe("production");
        expect(env.get(key)).toBe("production");

        open();
        await Promise.all([first, second]);

        expect(env.get(key)).toBeUndefined();
    });

    // Regression test: PR #456 review round 2 — a nested scope changed a key that another running
    // scope shared, so that scope saw a value it never asked for
    it("withScoped refuses a nested override of a key another running scope shares", async () => {
        const key = "GT_SCOPED_NESTED_SHARED_PROBE";
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        let siblingSaw: string | undefined;
        const sibling = env.withScoped({ [key]: "production" }, async () => {
            await gate;
            siblingSaw = env.get(key);
        });

        await env.withScoped({ [key]: "production" }, async () => {
            await expect(env.withScoped({ [key]: "development" }, () => undefined)).rejects.toThrow(key);
            expect(env.get(key)).toBe("production");
        });

        open();
        await sibling;

        expect(siblingSaw).toBe("production");
        expect(env.get(key)).toBeUndefined();
    });

    it("withScoped makes a same-value scope wait while a nested override changes the key", async () => {
        const key = "GT_SCOPED_NESTED_WAIT_PROBE";
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        let markEntered = (): void => undefined;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        let laterSaw: string | undefined;

        const outer = env.withScoped({ [key]: "production" }, async () => {
            await env.withScoped({ [key]: "development" }, async () => {
                markEntered();
                await gate;
            });
        });

        await entered;
        const later = env.withScoped({ [key]: "production" }, () => {
            laterSaw = env.get(key);
        });
        await Bun.sleep(0);

        expect(laterSaw).toBeUndefined();

        open();
        await outer;
        await later;

        expect(laterSaw).toBe("production");
        expect(env.get(key)).toBeUndefined();
    });

    // Regression test: PR #456 review round 3 — a separate scope asking for the nested value joined
    // the hold, and the nested scope's restore then put the outer value under it
    it("withScoped never lets a separate scope join a nested override's value", async () => {
        const key = "GT_SCOPED_NESTED_JOIN_PROBE";
        let openNested = (): void => undefined;
        const nestedGate = new Promise<void>((resolve) => {
            openNested = resolve;
        });
        let openSeparate = (): void => undefined;
        const separateGate = new Promise<void>((resolve) => {
            openSeparate = resolve;
        });
        let markEntered = (): void => undefined;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        const seen: (string | undefined)[] = [];

        const outer = env.withScoped({ [key]: "A" }, async () => {
            await env.withScoped({ [key]: "B" }, async () => {
                markEntered();
                await nestedGate;
            });
        });

        await entered;
        const separate = env.withScoped({ [key]: "B" }, async () => {
            seen.push(env.get(key));
            await separateGate;
            seen.push(env.get(key));
        });
        await Bun.sleep(0);
        openNested();
        await outer;
        await Bun.sleep(0);
        openSeparate();
        await separate;

        expect(seen).toEqual(["B", "B"]);
        expect(env.get(key)).toBeUndefined();
    });

    // Regression test: PR #456 review round 3 — a scope waiting for the outer value was woken only
    // when the whole outer hold ended, so an outer scope that awaited it never finished
    it("withScoped wakes a waiting scope when a nested override ends", async () => {
        const key = "GT_SCOPED_NESTED_WAKE_PROBE";
        let openNested = (): void => undefined;
        const nestedGate = new Promise<void>((resolve) => {
            openNested = resolve;
        });
        let markEntered = (): void => undefined;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        let separate: Promise<void> = Promise.resolve();
        let separateSaw: string | undefined;

        const outer = env.withScoped({ [key]: "A" }, async () => {
            await env.withScoped({ [key]: "B" }, async () => {
                markEntered();
                await nestedGate;
            });
            await separate;
        });

        await entered;
        separate = env.withScoped({ [key]: "A" }, () => {
            separateSaw = env.get(key);
        });
        await Bun.sleep(0);
        openNested();

        const outcome = await Promise.race([outer.then(() => "finished"), Bun.sleep(1000).then(() => "stuck")]);

        expect(outcome).toBe("finished");
        expect(separateSaw).toBe("A");
        expect(env.get(key)).toBeUndefined();
    });

    // Regression test: PR #456 review round 4 — two concurrent nested scopes in one outer flow
    // both counted as the outer holder, so the sibling that ended last put back the other's value
    it("withScoped refuses a concurrent sibling nested override, and the outer value survives", async () => {
        const key = "GT_SCOPED_NESTED_SIBLING_PROBE";
        let openFirst = (): void => undefined;
        const firstGate = new Promise<void>((resolve) => {
            openFirst = resolve;
        });
        let outerSaw: string | undefined;

        await env.withScoped({ [key]: "A" }, async () => {
            const first = env.withScoped({ [key]: "B" }, () => firstGate);
            await Bun.sleep(0);

            await expect(env.withScoped({ [key]: "C" }, () => undefined)).rejects.toThrow(key);

            openFirst();
            await first;
            outerSaw = env.get(key);
        });

        expect(outerSaw).toBe("A");
        expect(env.get(key)).toBeUndefined();
    });

    it("withScoped lets a nested scope nest again inside itself on the same key", async () => {
        const key = "GT_SCOPED_DEEP_NEST_PROBE";

        await env.withScoped({ [key]: "A" }, async () => {
            await env.withScoped({ [key]: "B" }, async () => {
                await env.withScoped({ [key]: "C" }, () => {
                    expect(env.get(key)).toBe("C");
                });

                expect(env.get(key)).toBe("B");
            });

            expect(env.get(key)).toBe("A");
        });
    });

    // Regression test: PR #456 review round 6 — two outer scopes, each awaiting a nested scope on the
    // other's key with a different value, waited on each other forever
    it("withScoped rejects the nested scope that would close a two-key wait cycle, and the other finishes", async () => {
        const [a, b] = ["GT_SCOPED_CYCLE_A_PROBE", "GT_SCOPED_CYCLE_B_PROBE"];
        let markA = (): void => undefined;
        let markB = (): void => undefined;
        const enteredA = new Promise<void>((resolve) => {
            markA = resolve;
        });
        const enteredB = new Promise<void>((resolve) => {
            markB = resolve;
        });

        const first = env.withScoped({ [a]: "1" }, async () => {
            markA();
            await enteredB;
            await env.withScoped({ [b]: "x" }, () => undefined);
        });
        const second = env.withScoped({ [b]: "2" }, async () => {
            markB();
            await enteredA;
            await Bun.sleep(0);
            await env.withScoped({ [a]: "y" }, () => undefined);
        });

        const outcomes = await Promise.race([
            Promise.allSettled([first, second]),
            Bun.sleep(1000).then(() => "stuck" as const),
        ]);

        expect(outcomes).not.toBe("stuck");
        const statuses = (outcomes as PromiseSettledResult<void>[]).map((o) => o.status).sort();
        expect(statuses).toEqual(["fulfilled", "rejected"]);
        expect(
            String((outcomes as PromiseSettledResult<void>[]).find((o) => o.status === "rejected")?.reason)
        ).toContain("deadlock");
        expect(env.get(a)).toBeUndefined();
        expect(env.get(b)).toBeUndefined();
    });

    it("withScoped lets a scope nest inside another on the same key", async () => {
        const key = "GT_SCOPED_NEST_PROBE";

        await env.withScoped({ [key]: "outer" }, async () => {
            await env.withScoped({ [key]: "inner" }, () => {
                expect(env.get(key)).toBe("inner");
            });

            expect(env.get(key)).toBe("outer");
        });

        expect(env.get(key)).toBeUndefined();
    });

    it("withScoped does not hold up a scope on other keys", async () => {
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        const blocked = env.withScoped({ GT_SCOPED_A_PROBE: "a" }, () => gate);
        let otherRan = false;

        await env.withScoped({ GT_SCOPED_B_PROBE: "b" }, () => {
            otherRan = true;
        });
        open();
        await blocked;

        expect(otherRan).toBe(true);
        expect(env.get("GT_SCOPED_A_PROBE")).toBeUndefined();
    });

    it("withoutProxy pins NODE_ENV to production, test, or development", async () => {
        await env.testing.withOverrides({ NODE_ENV: "production" }, () => {
            expect(env.withoutProxy().NODE_ENV).toBe("production");
            expect(env.withoutProxy({ NODE_ENV: "test" }).NODE_ENV).toBe("test");
            expect(env.withoutProxy({ NODE_ENV: "staging" }).NODE_ENV).toBe("development");
        });

        await env.testing.withOverrides({ NODE_ENV: "test" }, () => {
            expect(env.withoutProxy().NODE_ENV).toBe("test");
        });

        await env.testing.withOverrides({ NODE_ENV: "staging" }, () => {
            expect(env.withoutProxy().NODE_ENV).toBe("development");
        });

        await env.testing.withOverrides({ NODE_ENV: undefined }, () => {
            expect(env.withoutProxy().NODE_ENV).toBe("development");
        });
    });

    // Regression test: #446 item 4 (aside) — Ink entries need to force NODE_ENV=production
    // before react/react-reconciler are first evaluated, but only when nothing upstream
    // already decided (a developer running NODE_ENV=development, `bun test`'s NODE_ENV=test).
    it("node.setDefaultEnv sets NODE_ENV only when it is not already set", async () => {
        await env.testing.withOverrides({ NODE_ENV: undefined }, () => {
            env.node.setDefaultEnv("production");
            expect(env.get("NODE_ENV")).toBe("production");
        });

        await env.testing.withOverrides({ NODE_ENV: "development" }, () => {
            env.node.setDefaultEnv("production");
            expect(env.get("NODE_ENV")).toBe("development");
        });
    });

    it("resolves tools home with fallback to homedir", () => {
        const home = join(tmpdir(), "gt-home");
        env.testing.set("GENESIS_TOOLS_HOME", home);
        expect(env.tools.getHome()).toBe(home);
        expect(env.tools.getHomeEnvKey()).toBe("GENESIS_TOOLS_HOME");
    });

    it("withOverrides restores env after callback", async () => {
        env.testing.set("GENESIS_TOOLS_HOME", "before");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: "during" }, () => {
            expect(env.tools.getHome()).toBe("during");
        });

        expect(env.tools.getHome()).toBe("before");
    });
});
