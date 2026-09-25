import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import type { PsRow } from "@genesiscz/utils/process/ps";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    type MasterKeyProvider,
    secrets,
} from "@genesiscz/utils/security";
import { decisionFromReply } from "./approve";
import type { ProcessLookup } from "./client-identity";
import { auditPath, listGrants } from "./grants";
import { type GateDeps, providerTokenKind, providerTokenResolver, requestAccountAccess } from "./request";
import { type ApprovalDecision, GateDeniedError } from "./types";

function account(id: string, name: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

const ACCOUNTS = [
    account("acc_alice", "alice"),
    account("acc_bob", "bob", { provider: "openai-sub" }),
    account("acc_off", "off", { enabled: false }),
];

function row(pid: number, ppid: number, command: string): PsRow {
    return { pid, ppid, user: "alice", stat: "S", cpu: 0, rss: 0, startTime: null, command };
}

/** The client (700) spawned the gate door (800 → 900); 555 is a bystander on another branch. */
const ROWS = [
    row(1, 0, "/sbin/launchd"),
    row(600, 1, "-zsh"),
    row(700, 600, "node /opt/pi/bin/pi"),
    row(800, 700, "tools ai gate request"),
    row(900, 800, "bun gate request"),
    row(555, 600, "node /opt/other/bin/other"),
];
const SELF_PID = 900;
const lookup: ProcessLookup = {
    psInfo: (pids) => new Map(ROWS.filter((entry) => pids.includes(entry.pid)).map((entry) => [entry.pid, entry])),
    cwd: () => new Map(),
    executable: (pids) =>
        new Map(
            ROWS.filter((entry) => pids.includes(entry.pid)).map((entry) => [entry.pid, entry.command.split(" ")[0]])
        ),
    // `ps eww` answers with at least the command line; no code-loading variables are set.
    environment: (pids) =>
        new Map(ROWS.filter((entry) => pids.includes(entry.pid)).map((entry) => [entry.pid, entry.command])),
    fileStamps: (paths) => new Map(paths.map((path) => [path, `stamp:${path}`])),
};

interface Harness {
    deps: GateDeps;
    prompts: number;
    resolves: number;
}

/** The token resolver THROWS unless the approver allowed: a path that reaches it wrongly fails loudly. */
function harness(decision: ApprovalDecision): Harness {
    const state: Harness = { prompts: 0, resolves: 0, deps: {} };
    let allowed = false;
    state.deps = {
        lookup,
        selfPid: SELF_PID,
        loadAccounts: async () => ACCOUNTS,
        now: () => 1_000_000,
        tokenKind: async (provider) => (provider === "anthropic-sub" ? "long-lived" : "access"),
        approve: async () => {
            state.prompts++;
            allowed = decision.decision === "allow";
            return decision;
        },
        resolveToken: async (_provider, entry, kind) => {
            state.resolves++;

            if (!allowed) {
                throw new Error(`token resolved for ${entry.name} without an allow`);
            }

            return { accessToken: `tok-${entry.name}`, expiresAt: 2_000_000, kind };
        },
    };
    return state;
}

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-test-home-gate-")));
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("requestAccountAccess", () => {
    test("a fresh request prompts, and an allow reaches the token resolver (negative control)", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 0, method: "touch-id" });
        const result = await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );

        expect(h.prompts).toBe(1);
        expect(h.resolves).toBe(1);
        expect(result.accessToken).toBe("tok-alice");
        expect(result.prompted).toBe(true);
        expect(result.grantedUntil).toBeNull();
        expect(listGrants(1_000_000)).toEqual([]);
    });

    test("the window is told which token kind it approves, and the result carries it", async () => {
        const kinds: string[] = [];
        const h = harness({ decision: "allow", rememberSeconds: 0, method: "touch-id" });
        const approve = h.deps.approve;
        h.deps.approve = async (request) => {
            kinds.push(request.tokenKind);
            return approve ? approve(request) : { decision: "deny", reason: "no approver" };
        };

        const alice = await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );
        const bob = await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "openai-sub", account: "bob" },
            h.deps
        );

        expect(kinds).toEqual(["long-lived", "access"]);
        expect(alice.tokenKind).toBe("long-lived");
        expect(bob.tokenKind).toBe("access");
        expect(readFileSync(auditPath(), "utf8")).toContain('"event":"prompted"');
    });

    test("a deny never reaches the token resolver", async () => {
        const h = harness({ decision: "deny", reason: "no" });

        await expect(
            requestAccountAccess(
                { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
                h.deps
            )
        ).rejects.toMatchObject({ code: "denied" });
        expect(h.prompts).toBe(1);
        expect(h.resolves).toBe(0);
        expect(readFileSync(auditPath(), "utf8")).toContain('"event":"denied"');
    });

    test("an allow with a duration is remembered, and the next request does not prompt", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 3600, method: "touch-id" });
        const first = await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );
        const second = await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );

        expect(first.grantedUntil).toBe(1_000_000 + 3_600_000);
        expect(h.prompts).toBe(1);
        expect(second.prompted).toBe(false);
        expect(second.grantedUntil).toBe(first.grantedUntil);
        expect(h.resolves).toBe(2);
    });

    test("a remembered grant stops covering the account once its token kind changes", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 3600, method: "touch-id" });
        const request = { client: { name: "pi", pid: 700 }, provider: "anthropic-sub" as const, account: "alice" };
        await requestAccountAccess(request, h.deps);

        // The long-lived token was removed after the grant: the next request must ask again.
        h.deps.tokenKind = async () => "access";
        const after = await requestAccountAccess(request, h.deps);

        expect(h.prompts).toBe(2);
        expect(after).toMatchObject({ prompted: true, tokenKind: "access" });
    });

    test("a resolver that returns another kind than the window approved is a denial, never a hand-out", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 0, method: "touch-id" });
        h.deps.resolveToken = async () => ({ accessToken: "tok-access", expiresAt: null, kind: "access" });

        await expect(
            requestAccountAccess(
                { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
                h.deps
            )
        ).rejects.toMatchObject({ code: "token_kind_changed" });
        expect(readFileSync(auditPath(), "utf8")).toContain("approved long-lived, resolver returned access");
    });

    test("the real resolver refuses a long-lived request it cannot honour instead of falling back", async () => {
        const openai = ACCOUNTS.find((entry) => entry.provider === "openai-sub");

        if (!openai) {
            throw new Error("fixture needs an openai-sub account");
        }

        await expect(providerTokenResolver("openai-sub", openai, "long-lived")).rejects.toMatchObject({
            code: "token_kind_changed",
        });
    });

    test("a grant for one account does not cover another account or another client", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 3600, method: "touch-id" });
        await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );
        await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "openai-sub", account: "bob" },
            h.deps
        );
        await requestAccountAccess({ client: { name: "other" }, provider: "anthropic-sub", account: "alice" }, h.deps);

        expect(h.prompts).toBe(3);
    });

    test("unknown, disabled and mismatched accounts are refused before any window", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 0, method: "touch-id" });
        const attempts: Array<[string, "anthropic-sub" | "openai-sub", string]> = [
            ["nobody", "anthropic-sub", "unknown_account"],
            ["off", "anthropic-sub", "disabled_account"],
            ["bob", "anthropic-sub", "provider_mismatch"],
        ];

        for (const [name, provider, code] of attempts) {
            const error = await requestAccountAccess(
                { client: { name: "pi", pid: 700 }, provider, account: name },
                h.deps
            ).catch((e) => e);
            expect(error).toBeInstanceOf(GateDeniedError);
            expect(error.code).toBe(code);
        }

        expect(h.prompts).toBe(0);
        expect(h.resolves).toBe(0);
    });

    test("an unverified client (no running pid) is prompted every time and never remembered", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 3600, method: "touch-id" });
        const first = await requestAccountAccess(
            { client: { name: "pi", pid: 4242 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );
        expect(first.grantedUntil).toBeNull();
        expect(listGrants(1_000_000)).toHaveLength(0);

        await requestAccountAccess(
            { client: { name: "pi", pid: 4242 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );
        expect(h.prompts).toBe(2);
    });

    test("a running pid that did not start the request is refused before any window", async () => {
        const remembered = harness({ decision: "allow", rememberSeconds: 3600, method: "touch-id" });
        await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
            remembered.deps
        );
        expect(listGrants(1_000_000)).toHaveLength(1);

        // The bystander (555) names Pi's pid; the gate it spawned hangs below 555, not below 700.
        const bystander = harness({ decision: "allow", rememberSeconds: 0, method: "touch-id" });
        bystander.deps.selfPid = 555;
        await expect(
            requestAccountAccess(
                { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
                bystander.deps
            )
        ).rejects.toMatchObject({ code: "foreign_pid" });
        expect(bystander.prompts).toBe(0);
        expect(bystander.resolves).toBe(0);
    });

    test("a real ancestor whose binary lsof cannot read is prompted once, never refused, never remembered", async () => {
        const h = harness({ decision: "allow", rememberSeconds: 3600, method: "touch-id" });
        h.deps.lookup = { ...lookup, executable: () => new Map() };
        const result = await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub", account: "alice" },
            h.deps
        );

        expect(result.prompted).toBe(true);
        expect(result.grantedUntil).toBeNull();
        expect(h.resolves).toBe(1);
        expect(listGrants(1_000_000)).toHaveLength(0);
    });
});

describe("API keys (xai, openai)", () => {
    const SECRET = "xai-stored-in-the-gate-account";
    const MASTER = randomBytes(32);
    let vaultOpens = 0;
    let vaultLocked = false;

    function openVault(): Buffer {
        vaultOpens++;

        if (vaultLocked) {
            throw new Error("the vault was opened on a path that must never reach it");
        }

        return MASTER;
    }

    /** The master-key read every vault access starts with: counted, and it THROWS once locked. */
    const keyring: MasterKeyProvider = {
        id: "keychain",
        available: async () => true,
        get: async () => openVault(),
        getSync: () => openVault(),
        set: async () => {},
    };

    const envOnly = account("acc_xai_env", "xai-env", {
        provider: "xai",
        billing: { mode: "metered" },
        useEnvApiKey: ["XAI_API_KEY"],
    });

    /** A gate-only account whose key sits in the test vault; the spy counts from zero afterwards. */
    async function gateAccount(): Promise<AccountEntry> {
        const ref = await (await secrets()).set("ai/acc_xai_gate/apiKey", SECRET);
        _resetSecretsForTest();
        _setMasterKeyProvidersForTest([keyring]);
        vaultOpens = 0;

        return account("acc_xai_gate", "xai-gate", {
            provider: "xai",
            billing: { mode: "metered" },
            tags: ["gate-only"],
            credentials: { apiKey: ref },
        });
    }

    /** The real token resolver (it reads the test vault); the approver is the only stand-in. */
    function deps(accounts: AccountEntry[], decide: () => ApprovalDecision, prompts: { count: number }): GateDeps {
        return {
            lookup,
            selfPid: SELF_PID,
            now: () => 1_000_000,
            loadAccounts: async () => accounts,
            approve: async (request) => {
                prompts.count++;
                expect(request.tokenKind).toBe("api-key");
                return decide();
            },
        };
    }

    beforeEach(() => {
        vaultLocked = false;
        vaultOpens = 0;
        _setMasterKeyProvidersForTest([keyring]);
        _resetSecretsForTest();
        // The gate process's own environment holds ANOTHER key; the gate must never hand that out.
        env.testing.set("XAI_API_KEY", "xai-from-the-gate-process-environment");
    });

    afterEach(() => {
        env.testing.unset("XAI_API_KEY");
        _resetMasterKeyProviders();
        _resetSecretsForTest();
    });

    test("an allow hands out the account's STORED key, never the environment's, and the audit never holds it", async () => {
        const gate = await gateAccount();
        const prompts = { count: 0 };
        const result = await requestAccountAccess(
            { client: { name: "Genesis", pid: 700 }, provider: "xai" },
            deps([envOnly, gate], () => ({ decision: "allow", rememberSeconds: 0, method: "touch-id" }), prompts)
        );

        expect(result).toMatchObject({
            accessToken: SECRET,
            tokenKind: "api-key",
            expiresAt: null,
            grantedUntil: null,
            prompted: true,
            account: { id: "acc_xai_gate", name: "xai-gate" },
        });
        expect(prompts.count).toBe(1);
        expect(vaultOpens).toBeGreaterThan(0);
        expect(listGrants(1_000_000)).toEqual([]);

        const audit = readFileSync(auditPath(), "utf8");
        expect(audit).toContain('"event":"allowed"');
        expect(audit).toContain("api-key");
        expect(audit).not.toContain(SECRET);
    });

    test("a deny, a cancel or a timeout returns nothing, remembers nothing and never opens the vault", async () => {
        const gate = await gateAccount();
        vaultLocked = true;

        for (const reason of ["denied in the approval window", "User canceled.", "timeout: gate.approve timed out"]) {
            const prompts = { count: 0 };
            const error = await requestAccountAccess(
                { client: { name: "Genesis", pid: 700 }, provider: "xai", account: "xai-gate" },
                deps([envOnly, gate], () => ({ decision: "deny", reason }), prompts)
            ).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(GateDeniedError);
            expect(error).toMatchObject({ code: "denied" });
            expect(String(error)).toContain(reason);
            expect(prompts.count).toBe(1);
        }

        expect(vaultOpens).toBe(0);
        expect(listGrants(1_000_000)).toEqual([]);

        const audit = readFileSync(auditPath(), "utf8");
        expect(audit).toContain("timeout: gate.approve timed out");
        expect(audit).not.toContain(SECRET);
    });

    test("a remembered grant answers the next request without a window", async () => {
        const gate = await gateAccount();
        const prompts = { count: 0 };
        const d = deps(
            [envOnly, gate],
            () => {
                if (prompts.count > 1) {
                    throw new Error("the window opened although a grant was remembered");
                }

                return { decision: "allow", rememberSeconds: 8 * 3600, method: "touch-id" };
            },
            prompts
        );

        const first = await requestAccountAccess({ client: { name: "Genesis", pid: 700 }, provider: "xai" }, d);
        const second = await requestAccountAccess({ client: { name: "Genesis", pid: 700 }, provider: "xai" }, d);

        expect(first.grantedUntil).toBe(1_000_000 + 8 * 3600 * 1000);
        expect(second).toMatchObject({ prompted: false, accessToken: SECRET, grantedUntil: first.grantedUntil });
        expect(prompts.count).toBe(1);
        expect(listGrants(1_000_000)).toMatchObject([
            { provider: "xai", accountName: "xai-gate", tokenKind: "api-key" },
        ]);
    });

    test("an account that stores no key is refused before any window, even with the variable set", async () => {
        vaultLocked = true;
        const prompts = { count: 0 };
        const allow = (): ApprovalDecision => ({ decision: "allow", rememberSeconds: 0, method: "touch-id" });
        const named = await requestAccountAccess(
            { client: { name: "Genesis", pid: 700 }, provider: "xai", account: "xai-env" },
            deps([envOnly], allow, prompts)
        ).catch((e: unknown) => e);
        const unnamed = await requestAccountAccess(
            { client: { name: "Genesis", pid: 700 }, provider: "xai" },
            deps([envOnly], allow, prompts)
        ).catch((e: unknown) => e);

        expect(named).toMatchObject({ code: "no_stored_key" });
        expect(unnamed).toMatchObject({ code: "unknown_account" });
        expect(String(unnamed)).toContain("--tag gate-only --api-key-stdin");
        expect(prompts.count).toBe(0);
        expect(vaultOpens).toBe(0);
    });

    test("subscription requests keep their token kinds and never become an API key (negative control)", async () => {
        const codex = ACCOUNTS[1];

        expect(await providerTokenKind("openai-sub", codex)).toBe("access");
        expect(await providerTokenKind("xai", envOnly)).toBe("api-key");
        await expect(providerTokenResolver("openai-sub", codex, "api-key")).rejects.toMatchObject({
            code: "token_kind_changed",
        });
        await expect(providerTokenResolver("xai", envOnly, "access")).rejects.toMatchObject({
            code: "token_kind_changed",
        });

        const h = harness({ decision: "allow", rememberSeconds: 0, method: "touch-id" });
        const unnamed = await requestAccountAccess(
            { client: { name: "pi", pid: 700 }, provider: "anthropic-sub" },
            h.deps
        ).catch((e: unknown) => e);

        expect(unnamed).toMatchObject({ code: "unknown_account" });
        expect(h.prompts).toBe(0);
        expect(h.resolves).toBe(0);
    });
});

describe("decisionFromReply (the approval window's answer)", () => {
    test("every failure to get a clear allow is a deny with its reason", () => {
        expect(decisionFromReply({ ok: false, error: { code: "timeout", message: "gate.approve timed out" } })).toEqual(
            {
                decision: "deny",
                reason: "timeout: gate.approve timed out",
            }
        );
        expect(decisionFromReply({ ok: true, result: { decision: "deny", reason: "cancelled" } })).toEqual({
            decision: "deny",
            reason: "cancelled",
        });
        expect(decisionFromReply({ ok: true, result: { decision: "deny" } })).toMatchObject({ decision: "deny" });
    });

    test("an allow keeps an offered duration, and anything the window never offered becomes allow once", () => {
        const allow = (rememberSeconds: number | undefined) =>
            decisionFromReply({ ok: true, result: { decision: "allow", rememberSeconds, method: "touch-id" } });

        expect(allow(8 * 3600)).toEqual({ decision: "allow", rememberSeconds: 8 * 3600, method: "touch-id" });
        expect(allow(undefined)).toMatchObject({ rememberSeconds: 0 });
        expect(allow(10 ** 12)).toMatchObject({ rememberSeconds: 0 });
        expect(allow(-5)).toMatchObject({ rememberSeconds: 0 });
        expect(allow(3600.5)).toMatchObject({ rememberSeconds: 0 });
        expect(
            decisionFromReply({ ok: true, result: { decision: "allow", rememberSeconds: 0, method: "sudo" } })
        ).toMatchObject({ method: "none" });
    });
});

describe("tools ai gate request (CLI door)", () => {
    function gateCli(args: string[]) {
        const home = mkdtempSync(join(tmpdir(), "gt-test-home-gate-cli-"));
        const script = join(import.meta.dir, "..", "..", "..", "ai", "index.ts");

        return Bun.spawnSync([process.execPath, script, "gate", ...args], {
            env: { ...env.getProcessEnv(), GENESIS_TOOLS_HOME: home, GENESIS_TOOLS_NO_APP: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
    }

    function gateRequest(...extra: string[]) {
        return gateCli(["request", "--client", "pi", "--provider", "anthropic-sub", "--account", "nobody", ...extra]);
    }

    test("gate audit refuses a limit that is not a positive whole number instead of printing everything", () => {
        const proc = gateCli(["audit", "--limit", "abc"]);

        expect(proc.exitCode).toBe(1);
        expect(proc.stderr.toString()).toContain('--limit must be a positive whole number, got "abc"');
    });

    test("a denial exits 77 and names the code, before any window or token", () => {
        const proc = gateRequest();

        expect({ exitCode: proc.exitCode, stdout: proc.stdout.toString() }).toEqual({ exitCode: 77, stdout: "" });
        expect(proc.stderr.toString()).toContain("unknown_account");
    });

    test("an xai request with no account storing a key exits 77 before any window and names the store command", () => {
        const proc = gateCli(["request", "--client", "Genesis", "--provider", "xai"]);

        expect({ exitCode: proc.exitCode, stdout: proc.stdout.toString() }).toEqual({ exitCode: 77, stdout: "" });
        expect(proc.stderr.toString()).toContain("unknown_account");
        expect(proc.stderr.toString()).toContain("--tag gate-only");
    });

    test("a malformed --pid is an error (exit 1), never a silently unidentified client", () => {
        const proc = gateRequest("--pid", "12abc");

        expect(proc.exitCode).toBe(1);
        expect(proc.stderr.toString()).toContain('--pid must be a positive whole number, got "12abc"');
    });
});
