import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isError, namedAccount } from "@app/ai-proxy/lib/sessions/accounts";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import {
    autoAccount,
    resolveSessionEffort,
    resolveSessionModel,
    sessionArgs,
    sessionEnv,
} from "@app/claude/lib/codex-session/launch";
import { sessionKeyProblem } from "@app/claude/lib/codex-session/proxy-check";
import { guardSharedModel, isSessionOnlyModel, restoreSharedModel } from "@app/claude/lib/codex-session/settings-guard";
import { ensureOnboardingSkippedForOAuthToken } from "@app/claude/lib/launch-env";
import { type CodexModelInfo, mergeCodexModelRecords } from "@genesiscz/utils/ai/openai/codex-models";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { SafeJSON } from "@genesiscz/utils/json";

const catalog = mergeCodexModelRecords({ cache: [] });
const codexModel = (slug: string): CodexModelInfo | undefined => catalog.get(slug);
const NOW = new Date("2026-10-25T20:00:00.000Z");

function account(name: string, provider: AiProxyAccountConfig["provider"]): AiProxyAccountConfig {
    return { name, provider, providerSlug: provider === "openai-subscription" ? "codex" : "grok", enabled: true };
}

function snapshot(accountId: string, weekly: number): AccountUsageSnapshot {
    return {
        provider: "openai-sub",
        accountId,
        accountName: `login-${accountId}`,
        fetchedAt: NOW.toISOString(),
        limits: [
            { key: "primary", label: "5h", kind: "session", percentUsed: 10 },
            { key: "secondary", label: "Weekly", kind: "weekly", percentUsed: weekly },
        ],
    };
}

describe("model and effort", () => {
    it("defaults to sol at high, takes the P3 aliases, and refuses an unknown model", () => {
        const sol = resolveSessionModel(undefined, codexModel);
        const astra = resolveSessionModel("astra", codexModel);

        expect(isError(sol) ? sol.error : sol.slug).toBe("gpt-6.1-sol");
        expect(isError(astra) ? astra.error : astra.slug).toBe("gpt-6-astra");
        const terra = resolveSessionModel("terra", codexModel);
        expect(isError(terra) ? terra.error : terra.slug).toBe("gpt-6.1-terra");
        expect(resolveSessionModel("gpt-9-nope", codexModel)).toEqual({
            error: expect.stringContaining("sol, sol6, astra, terra, luna"),
        });
    });

    it("passes max, maps ultra like codex-rs, and refuses an effort the model lacks", () => {
        const info = codexModel("gpt-6.1-sol");

        if (!info) {
            throw new Error("the static catalog lost gpt-6.1-sol");
        }

        expect(resolveSessionEffort(info, undefined)).toEqual({ effort: "high" });
        expect(resolveSessionEffort(info, "max")).toEqual({ effort: "max" });
        expect(resolveSessionEffort(info, "ultra")).toEqual({ effort: "xhigh" });
        expect(resolveSessionEffort(info, "minimal")).toEqual({ error: expect.stringContaining("Allowed:") });
    });
});

describe("accounts (❓ DECISION 1 a: logins, with configured proxy accounts kept)", () => {
    const proxyAccounts = [account("legacy", "openai-subscription"), account("billed", "openai")];
    const logins = [
        { id: "id-work", name: "work" },
        { id: "id-side", name: "side" },
    ];

    it("names a configured proxy account first, then a login, and lists both when neither matches", () => {
        const proxy = namedAccount("legacy", proxyAccounts, logins, "codex");
        const login = namedAccount("side", proxyAccounts, logins, "codex");
        const metered = namedAccount("billed", proxyAccounts, logins, "codex");

        expect(isError(proxy) ? proxy.error : [proxy.proxyAccount?.name, proxy.login]).toEqual(["legacy", undefined]);
        expect(isError(login) ? login.error : [login.proxyAccount, login.login, login.metered]).toEqual([
            undefined,
            "side",
            false,
        ]);
        expect(isError(metered) ? metered.error : metered.metered).toBe(true);
        expect(namedAccount("nope", proxyAccounts, logins, "codex")).toEqual({
            error: expect.stringContaining("work, side, legacy, billed"),
        });
    });

    it("auto ranks the logins by their usage, with the runner-up", () => {
        const picked = autoAccount({
            agent: "codex",
            logins,
            snapshots: [snapshot("id-work", 80), snapshot("id-side", 20), snapshot("id-stranger", 0)],
            sessions: {},
            fallback: proxyAccounts,
            now: NOW,
        });

        expect(isError(picked) ? picked.error : [picked.login, picked.how, picked.runnerUp]).toEqual([
            "side",
            "auto",
            expect.stringContaining("work"),
        ]);
    });

    it("falls back on the one configured subscription account only when no login has usage data", () => {
        const noData = autoAccount({ agent: "codex", logins, snapshots: [], sessions: {}, fallback: proxyAccounts });
        const blocked = autoAccount({
            agent: "codex",
            logins,
            snapshots: [snapshot("id-work", 100), snapshot("id-side", 100)],
            sessions: {},
            fallback: proxyAccounts,
            now: NOW,
        });

        expect(isError(noData) ? noData.error : [noData.proxyAccount?.name, noData.how]).toEqual(["legacy", "only"]);
        expect(isError(blocked)).toBe(true);
    });
});

describe("environment and arguments", () => {
    const inherited = {
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "inherited-token",
        ANTHROPIC_API_KEY: "inherited-key",
        CLAUDE_CODE_EFFORT_LEVEL: "low",
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
        ANTHROPIC_AUTH_TOKEN: "gts_old",
    };

    it("sets the session's own values and drops what would bill elsewhere or override the subagents", () => {
        const env = sessionEnv(inherited, {
            baseUrl: "http://127.0.0.1:8317",
            key: "gts_test",
            model: "codex/gpt-6.1-sol",
            claude: { haiku: "claude-haiku-x", opus: "claude-opus-x", subscriptionType: "max" },
            smallCodexModel: "codex/gpt-6-luna:low",
            maxContextTokens: 475_000,
            compactPercent: 90,
            accountLabel: "codex:work+claude:personal",
        });

        expect(env).toEqual({
            PATH: "/usr/bin",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
            ANTHROPIC_AUTH_TOKEN: "gts_test",
            ANTHROPIC_MODEL: "codex/gpt-6.1-sol",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-x",
            ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-x",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-x",
            CLAUDE_CODE_SUBSCRIPTION_TYPE: "max",
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: "475000",
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: "475000",
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
            TOOLS_CLAUDE_ACCOUNT: "proxy:codex:work+claude:personal",
        });
    });

    it("puts the small slot on a Codex model when the session has no Claude account", () => {
        const env = sessionEnv(
            {},
            {
                baseUrl: "http://127.0.0.1:8317",
                key: "gts_test",
                model: "codex/gpt-6.1-sol",
                smallCodexModel: "codex/gpt-6-luna:low",
                maxContextTokens: 475_000,
                compactPercent: 90,
                accountLabel: "codex:work",
            }
        );

        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("codex/gpt-6-luna:low");
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    });

    it("passes --session-id for a new session and --resume for a resumed one; the user's own --effort wins", () => {
        const agents = ["--agents", "{}"];
        const settingsEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "475000" };

        expect(
            sessionArgs({
                sessionId: "s1",
                resume: false,
                effort: "high",
                agents,
                settingsEnv,
                passthrough: ["-p", "hi"],
            })
        ).toEqual([
            "--session-id",
            "s1",
            "--effort",
            "high",
            "--agents",
            "{}",
            "--settings",
            '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"475000"}}',
            "-p",
            "hi",
        ]);
        expect(
            sessionArgs({
                sessionId: "s1",
                resume: true,
                effort: "high",
                agents: [],
                settingsEnv,
                passthrough: ["--effort", "low", "--settings", "{}"],
            })
        ).toEqual(["--resume", "s1", "--effort", "low", "--settings", "{}"]);
    });
});

describe("the shared settings model guard (a /model pick must not become every session's default)", () => {
    function settingsFile(content: Record<string, unknown>): string {
        const path = join(mkdtempSync(join(tmpdir(), "codex-model-guard-")), "settings.json");
        writeFileSync(path, `${SafeJSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
        return path;
    }

    const read = (path: string): unknown => SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

    it("knows which ids only a proxy session can run", () => {
        expect(
            ["codex/gpt-6-astra", "grok/grok-4.6", "opus", "claude-opus-5-5[1m]", undefined].map(isSessionOnlyModel)
        ).toEqual([true, true, false, false, false]);
    });

    it("puts back the launch model and changes nothing else, mode included; a Claude id stays", () => {
        const path = settingsFile({ model: "codex/gpt-6-astra", env: { KEEP: "1" } });

        expect(restoreSharedModel(path, "opus")).toBe("codex/gpt-6-astra");
        expect(read(path)).toEqual({ model: "opus", env: { KEEP: "1" } });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        writeFileSync(path, SafeJSON.stringify({ model: "sonnet" }));
        expect(restoreSharedModel(path, "opus")).toBeUndefined();
        expect(read(path)).toEqual({ model: "sonnet" });
    });

    it("repairs a file that already holds a session-only id at launch, and drops the key on stop when there was none", () => {
        const broken = settingsFile({ model: "codex/gpt-6-astra", hooks: {} });
        const brokenGuard = guardSharedModel(broken);
        brokenGuard.stop();
        const clean = settingsFile({ hooks: {} });
        const cleanGuard = guardSharedModel(clean);
        writeFileSync(clean, SafeJSON.stringify({ model: "grok/grok-4.6", hooks: {} }));
        cleanGuard.stop();

        expect([brokenGuard.launchModel, read(broken)]).toEqual([undefined, { hooks: {} }]);
        expect(read(clean)).toEqual({ hooks: {} });
    });

    it("repairs a save the folder watch never reported, through its slow check", async () => {
        const path = settingsFile({ model: "opus" });
        // A watch that never fires, as a deaf fs.watch on Bun 1.3.13.
        const guard = guardSharedModel(path, { pollMs: 100, watchFolder: () => ({ close() {} }) });

        try {
            writeFileSync(path, SafeJSON.stringify({ model: "codex/gpt-6-astra" }));
            const deadline = Date.now() + 5_000;

            while ((read(path) as { model?: string }).model !== "opus" && Date.now() < deadline) {
                await Bun.sleep(100);
            }

            expect(read(path)).toEqual({ model: "opus" });
        } finally {
            guard.stop();
        }
    });

    it("logs a check that throws and repairs the file on a later check, instead of ending the launcher", async () => {
        const path = settingsFile({ model: "opus" });
        const guard = guardSharedModel(path, { pollMs: 50, watchFolder: () => ({ close() {} }) });
        // A read-only folder refuses the guard's temp file, so its check throws EACCES.
        chmodSync(dirname(path), 0o555);

        try {
            writeFileSync(path, SafeJSON.stringify({ model: "codex/gpt-6-astra" }));
            await Bun.sleep(200);
            expect(read(path)).toEqual({ model: "codex/gpt-6-astra" });
            chmodSync(dirname(path), 0o755);
            const deadline = Date.now() + 5_000;

            while ((read(path) as { model?: string }).model !== "opus" && Date.now() < deadline) {
                await Bun.sleep(50);
            }

            expect(read(path)).toEqual({ model: "opus" });
        } finally {
            chmodSync(dirname(path), 0o755);
            guard.stop();
        }
    });

    it("skips onboarding in the folder the child gets as CLAUDE_CONFIG_DIR", async () => {
        const isolated = mkdtempSync(join(tmpdir(), "codex-isolated-config-"));

        await ensureOnboardingSkippedForOAuthToken(isolated);

        expect(read(join(isolated, ".claude.json"))).toEqual({ hasCompletedOnboarding: true });
    });
});

describe("the session key check before Claude Code starts", () => {
    const KEY = "gts_fixture-key";

    async function check(answer: (req: Request) => Response): Promise<string | undefined> {
        const server = Bun.serve({ port: 0, fetch: answer });

        try {
            return await sessionKeyProblem({
                baseUrl: `http://127.0.0.1:${server.port}`,
                key: KEY,
                model: "codex/gpt-6.1-sol",
            });
        } finally {
            server.stop(true);
        }
    }

    const refusal = (status: number, message: string) =>
        new Response(SafeJSON.stringify({ error: { message, type: "auth_error" } }), { status });

    it("passes a proxy that takes the key as a bearer on count_tokens", async () => {
        const problem = await check((req) =>
            new URL(req.url).pathname === "/v1/messages/count_tokens" &&
            req.headers.get("Authorization") === `Bearer ${KEY}`
                ? Response.json({ input_tokens: 1 })
                : refusal(401, "Invalid proxy API key")
        );

        expect(problem).toBeUndefined();
    });

    it("names the restart when the proxy is older than session keys (401)", async () => {
        const problem = await check(() => refusal(401, "Invalid proxy API key"));

        expect(problem).toContain("401 (Invalid proxy API key)");
        expect(problem).toContain("tools ai-proxy down && tools ai-proxy up");
    });

    it("names the other home when the proxy does not know the record (403)", async () => {
        const problem = await check(() => refusal(403, "unknown or closed session"));

        expect(problem).toContain("403 (unknown or closed session)");
        expect(problem).toContain("GENESIS_TOOLS_HOME");
    });

    it("does not block the launch on another failure or no answer", async () => {
        expect(await check(() => new Response("boom", { status: 500 }))).toBeUndefined();
        expect(
            await sessionKeyProblem({ baseUrl: "http://127.0.0.1:9", key: KEY, model: "codex/x", timeoutMs: 500 })
        ).toBeUndefined();
    });
});
