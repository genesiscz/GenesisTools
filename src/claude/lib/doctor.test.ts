import { describe, expect, test } from "bun:test";
import type { ApiLimit } from "@app/claude/lib/usage/api";
import type { Cached } from "@app/claude/lib/usage/shared-cache";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import {
    accountOwningKeychain,
    billsKeychain,
    diagnoseGroup,
    fallbackSuffix,
    groupSessions,
    MAX_USAGE_AGE_MS,
    modelFromArgv,
    parsePinnedProcesses,
    resolveKeychainIdentity,
    type SessionGroup,
} from "./doctor";

const NOW = new Date("2026-07-24T20:00:00.000Z");
const TOKEN = "sk-ant-oat01-configured";

function hoursFromNow(hours: number): string {
    return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

function account(name: string, longLivedToken = TOKEN): AIAccountEntry {
    return { name, provider: "anthropic-sub", tokens: { longLivedToken } };
}

function group(overrides: Partial<SessionGroup> = {}): SessionGroup {
    return {
        account: "work",
        token: TOKEN,
        processes: [{ pid: 1, tty: "ttys001", account: "work", token: TOKEN, isAgent: false }],
        ...overrides,
    };
}

function cache(opts: { weeklyUsed?: number; sessionUsed?: number; fableUsed?: number; ageMs?: number } = {}): Cached {
    const limits: ApiLimit[] = [
        {
            kind: "weekly_all",
            percent: opts.weeklyUsed ?? 10,
            severity: "normal",
            resets_at: hoursFromNow(50),
            scope: null,
            is_active: true,
        },
    ];

    if (opts.fableUsed !== undefined) {
        limits.push({
            kind: "weekly_scoped",
            percent: opts.fableUsed,
            severity: "normal",
            resets_at: hoursFromNow(50),
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
            is_active: true,
        });
    }

    return {
        fetchedAt: NOW.getTime() - (opts.ageMs ?? 60_000),
        accounts: [
            {
                accountName: "work",
                usage: {
                    five_hour: { utilization: opts.sessionUsed ?? 10, resets_at: hoursFromNow(3) },
                    seven_day: { utilization: opts.weeklyUsed ?? 10, resets_at: hoursFromNow(50) },
                    limits,
                },
            },
        ],
    };
}

describe("parsePinnedProcesses", () => {
    const line = (extra: string) =>
        `  4242 ttys003 /bin/claude --model claude-fable-5 ${extra} TOOLS_CLAUDE_ACCOUNT=work CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`;

    test("extracts pid, tty, account, token and model", () => {
        const [proc] = parsePinnedProcesses(line(""));

        expect(proc).toMatchObject({
            pid: 4242,
            tty: "ttys003",
            account: "work",
            token: TOKEN,
            model: "claude-fable-5",
            isAgent: false,
        });
    });

    test("marks agent-team teammates", () => {
        expect(parsePinnedProcesses(line("--agent-id abc"))[0].isAgent).toBe(true);
        expect(parsePinnedProcesses(line("--agent-id=abc"))[0].isAgent).toBe(true);
    });

    test("drops processes with no pin", () => {
        expect(parsePinnedProcesses("  111 ttys001 /bin/claude --model claude-opus-5")).toEqual([]);
    });

    test("drops a pin with no token", () => {
        expect(parsePinnedProcesses("  111 ttys001 /bin/claude TOOLS_CLAUDE_ACCOUNT=work")).toEqual([]);
    });
});

describe("modelFromArgv", () => {
    test("recognizes all three launcher forms", () => {
        expect(modelFromArgv(["--model", "claude-opus-5"])).toBe("claude-opus-5");
        expect(modelFromArgv(["--model=claude-opus-5"])).toBe("claude-opus-5");
        expect(modelFromArgv(["-m", "claude-opus-5"])).toBe("claude-opus-5");
    });

    test("undefined when no model was pinned", () => {
        expect(modelFromArgv(["/bin/claude", "--resume"])).toBeUndefined();
    });
});

describe("groupSessions", () => {
    test("groups by account AND exact token", () => {
        const procs = parsePinnedProcesses(
            [
                `  1 ttys001 claude TOOLS_CLAUDE_ACCOUNT=work CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`,
                `  2 ttys002 claude TOOLS_CLAUDE_ACCOUNT=work CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`,
                "  3 ttys003 claude TOOLS_CLAUDE_ACCOUNT=work CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-older",
            ].join("\n")
        );

        const groups = groupSessions(procs);

        expect(groups).toHaveLength(2);
        expect(groups[0].processes).toHaveLength(2);
    });
});

describe("diagnoseGroup", () => {
    test("a healthy group has no problems AND nothing unverified", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache(), "ok", NOW);

        expect(diag.problems).toEqual([]);
        expect(diag.unverified).toEqual([]);
    });

    test("a 401 token is expired and bills the keychain", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache(), "invalid", NOW);

        expect(diag.problems).toContain("expired-token");
        expect(billsKeychain(diag.problems)).toBe(true);
    });

    test("an expired token suppresses bucket noise", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache({ weeklyUsed: 100 }), "invalid", NOW);

        expect(diag.problems).toEqual(["expired-token"]);
    });

    test("a token that differs from config is stale — a warning, not billing", () => {
        const diag = diagnoseGroup(group(), [account("work", "sk-ant-oat01-recaptured")], cache(), "ok", NOW);

        expect(diag.problems).toEqual(["stale-token"]);
        expect(billsKeychain(diag.problems)).toBe(false);
    });

    test("a pin naming a removed account is unknown-account", () => {
        const diag = diagnoseGroup(group(), [], cache(), "ok", NOW);

        expect(diag.problems).toContain("unknown-account");
    });

    test("a rate-limited probe still counts as authenticated — buckets decide", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache(), "limited", NOW);

        expect(diag.problems).toEqual([]);
    });

    test("an unreachable probe is unverified, never expired", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache(), "unreachable", NOW);

        expect(diag.problems).toEqual([]);
        expect(diag.unverified).toContain("probe-unreachable");
    });

    test("a missing cache entry is unverified, never green", () => {
        const diag = diagnoseGroup(group(), [account("work")], null, "ok", NOW);

        expect(diag.problems).toEqual([]);
        expect(diag.unverified).toContain("no-usage-data");
    });

    test("a snapshot older than the freshness gate is unverified", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache({ ageMs: MAX_USAGE_AGE_MS + 1000 }), "ok", NOW);

        expect(diag.unverified).toContain("usage-data-stale");
        expect(diag.problems).toEqual([]);
    });

    test("a stale-replayed entry is unverified", () => {
        const replayed = cache();
        replayed.accounts[0].stale = { lastSuccessAt: NOW.getTime() - 3_600_000, reason: "429" };

        expect(diagnoseGroup(group(), [account("work")], replayed, "ok", NOW).unverified).toContain("usage-data-stale");
    });

    test("a spent weekly bucket blocks every model", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache({ weeklyUsed: 100 }), "ok", NOW);

        expect(diag.problems).toContain("weekly-blocked");
        expect(billsKeychain(diag.problems)).toBe(true);
    });

    test("a spent 5h window is session-blocked", () => {
        const diag = diagnoseGroup(group(), [account("work")], cache({ sessionUsed: 100 }), "ok", NOW);

        expect(diag.problems).toContain("session-blocked");
    });

    test("a Fable session on a dead Fable bucket is flagged", () => {
        const fableGroup = group({
            processes: [
                { pid: 1, tty: "ttys001", account: "work", token: TOKEN, model: "claude-fable-5", isAgent: false },
            ],
        });

        expect(diagnoseGroup(fableGroup, [account("work")], cache({ fableUsed: 100 }), "ok", NOW).problems).toContain(
            "fable-blocked"
        );
    });

    test("an OPUS session on the same dead Fable bucket is NOT flagged", () => {
        const opusGroup = group({
            processes: [
                { pid: 1, tty: "ttys001", account: "work", token: TOKEN, model: "claude-opus-5", isAgent: false },
            ],
        });

        expect(diagnoseGroup(opusGroup, [account("work")], cache({ fableUsed: 100 }), "ok", NOW).problems).toEqual([]);
    });
});

describe("fallbackSuffix", () => {
    test("names the account absorbing the fallback when there is one", () => {
        expect(fallbackSuffix("expired-token", "other")).toBe(" → billing other");
    });

    // With no keychain login there is nothing to fall back onto, so claiming a
    // bill would be fabricated.
    test("says the turns just fail when no keychain login exists", () => {
        expect(fallbackSuffix("expired-token", undefined)).toContain("just fail");
        expect(fallbackSuffix("expired-token", undefined)).not.toContain("billing");
    });

    test("a non-billing problem gets no suffix at all", () => {
        expect(fallbackSuffix("stale-token", "other")).toBe("");
        expect(fallbackSuffix("unknown-account", "other")).toBe("");
    });
});

describe("accountOwningKeychain", () => {
    test("matches the account holding that secondary uuid", () => {
        const accounts = [
            account("a"),
            { ...account("b"), secondary: { accessToken: "x", refreshToken: "y", accountUuid: "uuid-b" } },
        ];

        expect(accountOwningKeychain(accounts, "uuid-b")).toBe("b");
    });

    // The regression: `find(a => a.secondary?.accountUuid === undefined)` matches
    // the FIRST account with no secondary, so an unmanaged keychain used to be
    // attributed to whichever account sat first in the config.
    test("an unknown identity owns nothing, even when no account has a secondary", () => {
        expect(accountOwningKeychain([account("first"), account("second")], undefined)).toBeUndefined();
    });

    test("a uuid no account claims owns nothing", () => {
        expect(accountOwningKeychain([account("a")], "uuid-nobody")).toBeUndefined();
    });
});

describe("resolveKeychainIdentity", () => {
    test("the authoritative lookup wins when both are available", async () => {
        const uuid = await resolveKeychainIdentity({
            readPayload: async () => ({ claudeAiOauth: {} }),
            resolveUuid: async () => "authoritative",
            offlineUuid: async () => "offline",
            onDegrade: () => {},
        });

        expect(uuid).toBe("authoritative");
    });

    test("missing keychain credentials fall back to the offline marker", async () => {
        const uuid = await resolveKeychainIdentity({
            readPayload: async () => null,
            resolveUuid: async () => "authoritative",
            offlineUuid: async () => "offline",
            onDegrade: () => {},
        });

        expect(uuid).toBe("offline");
    });

    test("a resolver failure degrades to the marker without aborting", async () => {
        let degraded = false;

        const uuid = await resolveKeychainIdentity({
            readPayload: async () => {
                throw new Error("keychain locked");
            },
            resolveUuid: async () => "authoritative",
            offlineUuid: async () => "offline",
            onDegrade: () => {
                degraded = true;
            },
        });

        expect(uuid).toBe("offline");
        expect(degraded).toBe(true);
    });

    test("everything unavailable yields undefined (unknown / unmanaged)", async () => {
        const uuid = await resolveKeychainIdentity({
            readPayload: async () => null,
            resolveUuid: async () => undefined,
            offlineUuid: async () => undefined,
            onDegrade: () => {},
        });

        expect(uuid).toBeUndefined();
    });
});

// A diagnostic that spends a single-use refresh token bricks the account it was
// asked to diagnose — that exact bug has shipped twice in this repo. These pin
// the two mutating doors shut at the source level, so a future edit that opens
// one fails here instead of in production.
describe("doctor never mutates", () => {
    const MUTATING = [
        // Rotates single-use refresh tokens unless noRefresh is passed.
        "resolveAccountToken",
        // Fetches (and therefore may rotate); the read-only door is peekSharedUsage.
        "getSharedAccountsUsage",
        // Writes the AI config.
        "updateAccount",
        // Bills a real inference request; the read-only door is probeLongLivedToken.
        "verifyLongLivedToken",
    ];

    test.each([
        ["src/claude/lib/doctor.ts"],
        ["src/claude/commands/doctor.ts"],
        ["src/claude/commands/doctor-impl.ts"],
    ])("%s calls no mutating API", async (path) => {
        const source = await Bun.file(path).text();

        for (const symbol of MUTATING) {
            expect(source).not.toContain(symbol);
        }
    });

    test("the doctor command reads the cache through peekSharedUsage", async () => {
        expect(await Bun.file("src/claude/commands/doctor-impl.ts").text()).toContain("peekSharedUsage");
    });

    test("the doctor command probes tokens read-only", async () => {
        expect(await Bun.file("src/claude/commands/doctor-impl.ts").text()).toContain("probeLongLivedToken");
    });
});
