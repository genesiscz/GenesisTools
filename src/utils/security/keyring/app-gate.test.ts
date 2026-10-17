import { afterEach, describe, expect, test } from "bun:test";
import { _setMasterKeyProvidersForTest, masterKey, masterKeySync, writeMasterKey } from "../MasterKey";
import {
    _resetVaultContextForTest,
    currentCommandLine,
    currentToolName,
    noteVaultSecret,
    redactCredentialArgs,
    redactCredentialText,
    setVaultPurpose,
} from "../vault-purpose";
import { appGateKey, createAppGateKeyProvider, VaultKeyDeniedError, type VaultUnlockRequest } from "./app-gate";
import type { MasterKeyProvider } from "./types";

const KEY = Buffer.alloc(32, 7);
const allow = { ok: true as const, result: { decision: "allow" as const, key: KEY.toString("base64") } };
const deny = { ok: true as const, result: { decision: "deny" as const, reason: "denied in the approval window" } };
const failure = (code: string) => ({ ok: false as const, error: { code, message: `${code} from the fake app` } });

/** A keychain stand-in that records reads and writes; `throwOnRead` proves a path never reached it. */
function fakeKeychain(stored: Buffer | undefined, throwOnRead = false) {
    const calls = { reads: 0, writes: [] as Buffer[] };
    const rung: MasterKeyProvider = {
        id: "keychain",
        available: async () => true,
        get: async () => rung.getSync?.(),
        getSync: () => {
            calls.reads++;
            if (throwOnRead) {
                throw new Error("the keychain was read after the app denied the key");
            }

            return stored;
        },
        set: async (key) => {
            calls.writes.push(key);
        },
    };
    return { rung, calls };
}

afterEach(() => {
    _resetVaultContextForTest();
    _setMasterKeyProvidersForTest([]);
});

describe("the app rung", () => {
    test("an allow returns the key the app read", async () => {
        const rung = createAppGateKeyProvider({ available: () => true, rpc: async () => allow, rpcSync: () => allow });

        expect(await rung.get()).toEqual(KEY);
        expect(rung.getSync?.()).toEqual(KEY);
    });

    test("concurrent cold reads share one delayed approval without poisoning later reads", async () => {
        const approval = Promise.withResolvers<typeof allow>();
        let asked = 0;
        const app = createAppGateKeyProvider({
            available: () => true,
            rpc: async () => {
                asked++;
                return approval.promise;
            },
        });
        const first = app.get();
        const second = app.get();
        expect(asked).toBe(1);
        approval.resolve(allow);
        expect(await Promise.all([first, second])).toEqual([KEY, KEY]);
        expect(await app.get()).toEqual(KEY);
        expect(asked).toBe(2);
    });

    test("concurrent denials share one decision and keep the existing refusal policy", async () => {
        const approval = Promise.withResolvers<typeof deny>();
        let asked = 0;
        const app = createAppGateKeyProvider({
            available: () => true,
            rpc: async () => {
                asked++;
                return approval.promise;
            },
        });
        const reads = Promise.allSettled([app.get(), app.get()]);
        expect(asked).toBe(1);
        approval.resolve(deny);
        expect((await reads).map((read) => read.status)).toEqual(["rejected", "rejected"]);
        await expect(app.get()).rejects.toThrow("denied in the approval window");
        expect(asked).toBe(1);
    });

    test("an RPC failure releases the in-flight request so a later read can retry", async () => {
        let asked = 0;
        const app = createAppGateKeyProvider({
            available: () => true,
            rpc: async () => {
                if (++asked === 1) {
                    throw new Error("fixture transport failure");
                }
                return allow;
            },
        });
        await expect(app.get()).rejects.toThrow("fixture transport failure");
        expect(await app.get()).toEqual(KEY);
        expect(asked).toBe(2);
    });

    test("a deny throws with the window's reason and never reaches the keychain", () => {
        const keychain = fakeKeychain(KEY, true);
        _setMasterKeyProvidersForTest([
            createAppGateKeyProvider({ available: () => true, rpcSync: () => deny }),
            keychain.rung,
        ]);

        expect(() => masterKeySync()).toThrow(VaultKeyDeniedError);
        expect(() => masterKeySync()).toThrow("denied in the approval window");
        expect(keychain.calls.reads).toBe(0);
    });

    test("an app that cannot answer lets the keychain answer, as before the app existed", async () => {
        for (const code of ["unavailable", "method_unknown", "handshake", "no_key"]) {
            const keychain = fakeKeychain(KEY);
            const app = createAppGateKeyProvider({
                available: () => true,
                rpc: async () => failure(code),
                rpcSync: () => failure(code),
            });
            _setMasterKeyProvidersForTest([app, keychain.rung]);

            expect(masterKeySync()).toEqual(KEY);
            expect(keychain.calls.reads).toBe(1);
        }
    });

    test("a refusal is final for the process: the next read throws without asking the app again", async () => {
        let asked = 0;
        const app = createAppGateKeyProvider({
            available: () => true,
            rpc: async () => {
                asked++;
                return deny;
            },
            rpcSync: () => {
                asked++;
                return failure("timeout");
            },
        });

        await expect(app.get()).rejects.toThrow("denied in the approval window");
        await expect(app.get()).rejects.toThrow("denied in the approval window");
        expect(() => app.getSync?.()).toThrow("denied in the approval window");
        expect(asked).toBe(1);
    });

    test("no answer within the window's time is a deny, not a fall-through to the keychain dialog", () => {
        const app = createAppGateKeyProvider({ available: () => true, rpcSync: () => failure("timeout") });

        expect(() => app.getSync?.()).toThrow("timeout");
    });

    test("without the app the rung asks nothing and the keychain answers", async () => {
        let asked = 0;
        const keychain = fakeKeychain(KEY);
        const app = createAppGateKeyProvider({
            available: () => false,
            rpc: async () => {
                asked++;
                return allow;
            },
        });
        _setMasterKeyProvidersForTest([app, keychain.rung]);

        expect(await masterKey()).toEqual(KEY);
        expect(asked).toBe(0);
    });

    test("the request carries why, what and the command", async () => {
        const seen: VaultUnlockRequest[] = [];
        setVaultPurpose("refresh the usage figures of 3 accounts for the statusline");
        noteVaultSecret("ai/acc_work/accessToken");
        noteVaultSecret("ai/acc_side/accessToken");
        const app = createAppGateKeyProvider({
            available: () => true,
            rpc: async (request) => {
                seen.push(request);
                return allow;
            },
        });

        await app.get();
        expect(seen[0]?.purpose).toBe("refresh the usage figures of 3 accounts for the statusline");
        expect(seen[0]?.secret).toBe("ai/acc_work/accessToken");
        expect(seen[0]?.command.startsWith("tools ")).toBe(true);
    });

    test("a new key is stored by the keychain, never by the app rung", async () => {
        const keychain = fakeKeychain(undefined);
        _setMasterKeyProvidersForTest([
            createAppGateKeyProvider({ available: () => true, rpc: async () => allow }),
            keychain.rung,
        ]);

        expect(await writeMasterKey(KEY)).toBe("keychain");
        expect(keychain.calls.writes).toEqual([KEY]);
    });

    test("a test process never reaches the real app", async () => {
        expect(await appGateKey.available()).toBe(false);
        expect(appGateKey.getSync?.()).toBeUndefined();
    });
});

describe("the caller's name and command", () => {
    test("credential arguments are redacted before commands and purposes are built", () => {
        const token = "fixture-secret-never-real";
        for (const flag of ["--token", "--api-key", "--key", "--password", "--secret"]) {
            for (const args of [[flag, token], [`${flag}=${token}`]]) {
                const argv = ["gt-claude", "/repo/src/claude/index.ts", "config", "add", "work", ...args];
                expect(currentCommandLine(argv)).not.toContain(token);
                expect(redactCredentialArgs(argv).join(" ")).toContain("[REDACTED]");
                expect(redactCredentialText(`run ${argv.join(" ")}`)).not.toContain(token);
            }
        }

        expect(redactCredentialText('run tools claude --token="fixture with spaces"')).toBe(
            "run tools claude --token=[REDACTED]"
        );
        expect(redactCredentialArgs(["tools", "wakeup", "daemon", "register", "-t", token]).at(-1)).toBe("[REDACTED]");
        expect(
            redactCredentialArgs(["bun", "/repo/src/wakeup/index.ts", "daemon", "register", `-t=${token}`]).at(-1)
        ).toBe("-t=[REDACTED]");
        expect(redactCredentialArgs(["tools", "claude", "tail", "-t", "5"]).at(-1)).toBe("5");
        expect(currentCommandLine(["gt-claude", "/repo/src/claude/index.ts", "--token", token], 40)).not.toContain(
            "fixture"
        );
    });

    test("from the tool's entry script, else from its gt- launcher", () => {
        expect(currentToolName(["/Users/x/.genesis-tools/bin/gt-claude", "/repo/src/claude/index.ts", "info"])).toBe(
            "claude"
        );
        expect(currentToolName(["/Users/x/.genesis-tools/bin/gt-say", "/somewhere/else.ts"])).toBe("say");
        expect(currentToolName(["/Users/x/.bun/bin/bun", "/repo/src/ai/commands/usage/poll-daemon.ts"])).toBe("ai");
        expect(
            currentToolName(
                ["/Users/x/.bun/bin/bun", "/repo/hooks/statusline.ts"],
                "/Users/x/.genesis-tools/bin/gt-claude"
            )
        ).toBe("claude");
        expect(currentToolName(["/Users/x/.bun/bin/bun", "/tmp/probe.ts"], "/Users/x/.bun/bin/bun")).toBe("probe");
        expect(currentCommandLine(["gt-say", "/repo/src/say/index.ts", "hello there", "--app", "claude"])).toBe(
            'tools say "hello there" --app claude'
        );
    });
});
