import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import { writeSnapshotsCache } from "../legacy-cache";
import { UsageLimitsDb } from "../limits-db";
import { __resetUsagePollStorage } from "../storage";
import type { AccountUsageSnapshot } from "../types";

/**
 * One fixed limits store for the golden tests of every door that reads it: the config, the
 * all-provider snapshots cache and `usage_snapshots` rows, all under a sandbox home. Every
 * handle is invented. Rows sit at least four minutes apart, so the 600-point and the
 * 720-point step defaults keep the same points over the 24 h window.
 */
export const FIXTURE_WINDOW = { from: "2026-10-31T12:00:00.000Z", to: "2026-11-01T12:00:00.000Z" } as const;

export const FIXTURE_FETCHED_AT = "2026-11-01T11:59:00.000Z";

interface FixtureRow {
    provider: string;
    account: string;
    key: string;
    kind: string;
    at: string;
    percent: number;
    resetsAt: string | null;
    severity: string | null;
    scopeModel?: string;
}

const ROWS: FixtureRow[] = [
    // Outside the window: no door may return it.
    row("anthropic-sub", "work", "five_hour", "session", "2026-10-30T12:00:00.000Z", 99, "2026-10-30T15:00:00.000Z"),
    row("anthropic-sub", "work", "five_hour", "session", "2026-10-31T13:00:00.000Z", 10, "2026-10-31T15:00:00.000Z"),
    row("anthropic-sub", "work", "five_hour", "session", "2026-10-31T14:00:00.000Z", 35, "2026-10-31T15:00:00.000Z"),
    row(
        "anthropic-sub",
        "work",
        "five_hour",
        "session",
        "2026-10-31T14:40:00.000Z",
        88,
        "2026-10-31T15:00:00.000Z",
        "warn"
    ),
    // The 15:00 reset: the window restarts at 0% with a later resets_at.
    row("anthropic-sub", "work", "five_hour", "session", "2026-10-31T15:05:00.000Z", 0, "2026-10-31T20:05:00.000Z"),
    row("anthropic-sub", "work", "five_hour", "session", "2026-11-01T08:40:00.000Z", 20, "2026-11-01T13:40:00.000Z"),
    row("anthropic-sub", "work", "five_hour", "session", "2026-11-01T09:02:00.000Z", 22, "2026-11-01T13:40:00.000Z"),
    row("anthropic-sub", "work", "five_hour", "session", "2026-11-01T09:06:00.000Z", 24, "2026-11-01T13:40:00.000Z"),
    row("anthropic-sub", "work", "seven_day", "weekly", "2026-10-31T13:00:00.000Z", 50, "2026-11-04T09:00:00.000Z"),
    row("anthropic-sub", "work", "seven_day", "weekly", "2026-11-01T09:00:00.000Z", 52, "2026-11-04T09:00:00.000Z"),
    row("anthropic-sub", "personal", "five_hour", "session", "2026-10-31T20:00:00.000Z", 5, null),
    row("openai-sub", "work", "primary", "weekly", "2026-10-31T18:00:00.000Z", 70, "2026-11-06T00:00:00.000Z"),
    row("openai-sub", "work", "primary", "weekly", "2026-11-01T08:00:00.000Z", 71, "2026-11-06T00:00:00.000Z"),
    // An account no config entry names any more: its history stays readable.
    row("grok-sub", "side", "weekly", "weekly", "2026-11-01T10:00:00.000Z", 30, "2026-11-05T00:00:00.000Z"),
];

function row(
    provider: string,
    account: string,
    key: string,
    kind: string,
    at: string,
    percent: number,
    resetsAt: string | null,
    severity: string | null = "ok"
): FixtureRow {
    return { provider, account, key, kind, at, percent, resetsAt, severity };
}

const CONFIG: AiConfigData = {
    version: CONFIG_VERSION,
    accounts: [
        account("acc_claude_work", "work", "anthropic-sub"),
        account("acc_claude_personal", "personal", "anthropic-sub"),
        account("acc_codex_work", "work", "openai-sub"),
    ],
    defaults: {},
};

function account(id: string, name: string, provider: string): AiConfigData["accounts"][number] {
    return {
        id,
        name,
        provider,
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
    };
}

export const FIXTURE_SNAPSHOTS: AccountUsageSnapshot[] = [
    {
        provider: "anthropic-sub",
        accountId: "acc_claude_work",
        accountName: "work",
        fetchedAt: FIXTURE_FETCHED_AT,
        limits: [
            {
                key: "five_hour",
                label: "5h",
                kind: "session",
                percentUsed: 24,
                resetsAt: "2026-11-01T13:40:00.000Z",
                periodMs: 18_000_000,
                severity: "ok",
            },
            {
                key: "seven_day",
                label: "7d",
                kind: "weekly",
                percentUsed: 52,
                resetsAt: "2026-11-04T09:00:00.000Z",
                periodMs: 604_800_000,
                severity: "ok",
            },
        ],
    },
    {
        provider: "openai-sub",
        accountId: "acc_codex_work",
        accountName: "work",
        fetchedAt: FIXTURE_FETCHED_AT,
        limits: [
            {
                key: "primary",
                label: "Weekly",
                kind: "weekly",
                percentUsed: 71,
                resetsAt: "2026-11-06T00:00:00.000Z",
                periodMs: 604_800_000,
            },
        ],
    },
];

/** Points every store at `home`, and drops each memoised handle that captured the old one. */
export function useLimitsHome(home: string): void {
    env.testing.set("GENESIS_TOOLS_HOME", home);
    ClaudeDatabase.closeInstance();
    AiConfigStore.invalidate();
    __resetUsagePollStorage();
}

export function releaseLimitsHome(): void {
    ClaudeDatabase.closeInstance();
    AiConfigStore.invalidate();
    __resetUsagePollStorage();
    env.testing.unset("GENESIS_TOOLS_HOME");
}

/** Writes the config, the snapshots cache and the rows into the home `useLimitsHome` selected. */
export async function seedLimitsStore(home: string): Promise<void> {
    const aiDir = genesisToolsDirIn(home, "ai");
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(join(aiDir, "config.json"), SafeJSON.stringify(CONFIG, null, 2));

    await writeSnapshotsCache(
        {
            "anthropic-sub": {
                alias: "claude",
                displayName: "Claude",
                prominent: ["five_hour", "seven_day"],
                accounts: FIXTURE_SNAPSHOTS.filter((s) => s.provider === "anthropic-sub"),
            },
            "openai-sub": {
                alias: "codex",
                displayName: "Codex",
                prominent: ["primary"],
                accounts: FIXTURE_SNAPSHOTS.filter((s) => s.provider === "openai-sub"),
            },
        },
        new Date(FIXTURE_FETCHED_AT)
    );

    const db = new UsageLimitsDb();

    for (const r of ROWS) {
        db.recordSnapshotV2(r.account, r.key, r.percent, r.at, {
            resetsAt: r.resetsAt,
            severity: r.severity,
            scopeModel: r.scopeModel ?? null,
            provider: r.provider,
            kind: r.kind,
        });
    }
}
