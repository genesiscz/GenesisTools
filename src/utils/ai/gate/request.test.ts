import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import type { PsRow } from "@genesiscz/utils/process/ps";
import { decisionFromReply } from "./approve";
import type { ProcessLookup } from "./client-identity";
import { auditPath, listGrants } from "./grants";
import { type GateDeps, providerTokenResolver, requestAccountAccess } from "./request";
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

    test("a malformed --pid is an error (exit 1), never a silently unidentified client", () => {
        const proc = gateRequest("--pid", "12abc");

        expect(proc.exitCode).toBe(1);
        expect(proc.stderr.toString()).toContain('--pid must be a positive whole number, got "12abc"');
    });
});
