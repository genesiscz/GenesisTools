import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    recordVaultExport,
    secrets,
} from "@genesiscz/utils/security";
import type { BindContext, HealthReport, ProviderPlugin } from "../providers/plugin-types";
import { _resetPluginsForTest, registerPlugin } from "../providers/registry";
import { AiConfigStore } from "./AiConfigStore";
import { EXPIRY_WARNING_MS, type DoctorCheck, type DoctorLevel, runDoctor } from "./doctor";
import { _clearExternalRefScanners } from "./refs";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "./schema";

const KEY = Buffer.alloc(32, 7);
const NOW = Date.UTC(2026, 6, 29);

let home: string;

function account(id: string, name: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider: "fake",
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

function config(overrides: Partial<AiConfigData> = {}): AiConfigData {
    return { version: CONFIG_VERSION, accounts: [], defaults: {}, ...overrides };
}

function writeConfig(data: AiConfigData): void {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
}

function fakePlugin(overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
    return {
        id: "fake",
        kind: "api-key",
        capabilities: new Set(["chat"] as const),
        credential: { fields: ["apiKey"], envKeys: ["FAKE_API_KEY"], required: ["apiKey"] },
        bind: async (ctx: BindContext) => ({
            accountId: ctx.account.id,
            providerId: "fake",
            billed: true,
            language: () => {
                throw new Error("not used in tests");
            },
        }),
        ...overrides,
    };
}

function find(checks: DoctorCheck[], id: string): DoctorCheck[] {
    return checks.filter((entry) => entry.id === id);
}

function levelOf(checks: DoctorCheck[], id: string): DoctorLevel | undefined {
    return find(checks, id)[0]?.level;
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-doctor-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        {
            id: "env",
            available: async () => true,
            get: async () => KEY,
            getSync: () => KEY,
            set: async () => {},
        },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    registerPlugin(fakePlugin());
    writeConfig(config());
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    env.testing.unset("FAKE_API_KEY");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _clearExternalRefScanners();
    AiConfigStore.invalidate();
});

describe("runDoctor: subsystem checks", () => {
    test("reports the master key rung and an empty readable vault", async () => {
        const report = await runDoctor({ now: NOW });

        expect(levelOf(report.checks, "master-key")).toBe("ok");
        expect(find(report.checks, "master-key")[0].detail).toContain("env rung");
        expect(levelOf(report.checks, "vault")).toBe("ok");
        expect(find(report.checks, "vault")[0].detail).toBe("0 entries readable");
        expect(report.ok).toBe(true);
    });

    test("nags about escrow once the vault holds anything, and stops once exported", async () => {
        const vault = await secrets();
        await vault.set("ai/acc_a/apiKey", "sk-live");
        writeConfig(config({ accounts: [account("acc_a", "one")] }));

        const before = await runDoctor({ now: NOW });
        expect(levelOf(before.checks, "escrow")).toBe("warn");

        await recordVaultExport(NOW);
        const after = await runDoctor({ now: NOW });
        expect(levelOf(after.checks, "escrow")).toBe("ok");
    });
});

describe("runDoctor: per-account checks", () => {
    test("a vaulted credential resolves and reports its source without the value", async () => {
        const vault = await secrets();
        const ref = await vault.set("ai/acc_a/apiKey", "sk-super-secret");
        writeConfig(config({ accounts: [account("acc_a", "one", { credentials: { apiKey: ref } })] }));

        const report = await runDoctor({ now: NOW });
        const credential = find(report.checks, "account.credential")[0];

        expect(credential.level).toBe("ok");
        expect(credential.detail).toBe("credential from vault");
        expect(SafeJSON.stringify(report)).not.toContain("sk-super-secret");
    });

    test("a missing credential fails the report", async () => {
        writeConfig(config({ accounts: [account("acc_a", "one")] }));

        const report = await runDoctor({ now: NOW });

        expect(levelOf(report.checks, "account.credential")).toBe("err");
        expect(report.ok).toBe(false);
    });

    test("a disabled account is not checked at all", async () => {
        writeConfig(config({ accounts: [account("acc_a", "one", { enabled: false })] }));

        const report = await runDoctor({ now: NOW });

        expect(find(report.checks, "account.credential")).toHaveLength(0);
        expect(report.ok).toBe(true);
    });

    test("an account whose provider has no plugin warns instead of throwing", async () => {
        writeConfig(config({ accounts: [account("acc_hf", "hf-cloud", { provider: "huggingface" })] }));

        const report = await runDoctor({ now: NOW });

        expect(levelOf(report.checks, "account.plugin")).toBe("warn");
        expect(report.ok).toBe(true);
    });

    test("expiry warns inside the window and fails once past", async () => {
        writeConfig(
            config({
                accounts: [
                    account("acc_soon", "soon", {
                        credentials: { expiresAt: NOW + EXPIRY_WARNING_MS - 1000 },
                    }),
                    account("acc_gone", "gone", { credentials: { refreshExpiresAt: NOW - 1000 } }),
                ],
            })
        );

        const report = await runDoctor({ now: NOW });
        const expiries = find(report.checks, "account.expiry");

        expect(expiries.find((entry) => entry.scope === "soon")?.level).toBe("warn");
        expect(expiries.find((entry) => entry.scope === "gone")?.level).toBe("err");
    });

    test("an env var the account ignores is surfaced as deliberate, with the fix command", async () => {
        env.testing.set("FAKE_API_KEY", "sk-from-env");
        const vault = await secrets();
        const ref = await vault.set("ai/acc_a/apiKey", "sk-configured");
        writeConfig(config({ accounts: [account("acc_a", "one", { credentials: { apiKey: ref } })] }));

        const report = await runDoctor({ now: NOW });
        const shadow = find(report.checks, "account.env-shadow")[0];

        expect(shadow.level).toBe("warn");
        expect(shadow.detail).toContain("--use-env FAKE_API_KEY");
    });

    test("health probes only run with live, and a failing probe fails the report", async () => {
        _resetPluginsForTest();
        registerPlugin(
            fakePlugin({
                credential: { fields: [], envKeys: [] },
                health: async (): Promise<HealthReport> => ({ ok: false, detail: "runtime unavailable" }),
            })
        );
        writeConfig(config({ accounts: [account("acc_a", "one")] }));

        const offline = await runDoctor({ now: NOW });
        expect(find(offline.checks, "account.health")).toHaveLength(0);

        const live = await runDoctor({ now: NOW, live: true });
        expect(levelOf(live.checks, "account.health")).toBe("err");
        expect(live.ok).toBe(false);
    });
});

describe("runDoctor: link and vault hygiene", () => {
    test("a default pointing at a deleted account is a dangling ref", async () => {
        writeConfig(
            config({
                accounts: [account("acc_a", "one", { credentials: { authFile: "/tmp/auth.json" } })],
                defaults: { account: { chat: "@account/acc_ghost" } },
            })
        );

        const report = await runDoctor({ now: NOW });
        const dangling = find(report.checks, "refs.dangling")[0];

        expect(dangling.level).toBe("err");
        expect(dangling.scope).toBe("defaults.account.chat");
        expect(dangling.detail).toContain("acc_ghost");
    });

    test("a vault entry no account owns is reported as an orphan", async () => {
        const vault = await secrets();
        await vault.set("ai/acc_removed/apiKey", "sk-left-behind");
        writeConfig(config());

        const report = await runDoctor({ now: NOW });
        const orphan = find(report.checks, "vault.orphan")[0];

        expect(orphan.level).toBe("warn");
        expect(orphan.scope).toBe("ai/acc_removed/apiKey");
    });

    test("counts add up and warnings alone keep the report ok", async () => {
        const vault = await secrets();
        await vault.set("ai/acc_removed/apiKey", "sk-left-behind");
        writeConfig(config());

        const report = await runDoctor({ now: NOW });
        const summed = report.counts.ok + report.counts.warn + report.counts.err;

        expect(summed).toBe(report.checks.length);
        expect(report.counts.err).toBe(0);
        expect(report.counts.warn).toBeGreaterThan(0);
        expect(report.ok).toBe(true);
    });
});
