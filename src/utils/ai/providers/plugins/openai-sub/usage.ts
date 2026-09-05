import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { AccountEntry } from "../../../config/schema";
import { AppServerClient, spawnAppServer } from "../../../openai/app-server-client";
import type { AccountUsageFeature, AccountUsageSnapshot, LimitWindow, UsagePollOptions } from "../../account-features";

/**
 * `accounts.usage` for the Codex (ChatGPT plan) subscription (spec 2026-09-04 section 6.6).
 *
 * The Codex CLI reports rate limits only over its app-server, so one poll starts a short
 * lived `codex app-server` for the account's `CODEX_HOME`, asks `account/rateLimits/read`
 * and stops it again. That is why the floor between two polls is 120s rather than 30s: a
 * process spawn per account per tick is not free.
 *
 * `probe` changes nothing here. Reading rate limits does not rotate our credential; if the
 * app-server refreshes its own auth file while running, that is the vendor CLI's behaviour
 * and is exactly what happens when the user runs `codex` themselves.
 */

const MIN_INTERVAL_MS = 120_000;

const REQUEST_TIMEOUT_MS = 10_000;

/** Anything longer than a day is the weekly window; the 5h one is the session window. */
const WEEKLY_THRESHOLD_MINS = 24 * 60;

/** The two windows the app-server names, in display order. */
const WINDOW_KEYS = ["primary", "secondary"] as const;

type WindowKey = (typeof WINDOW_KEYS)[number];

const WINDOW_LABELS: Record<WindowKey, string> = {
    primary: "Session",
    secondary: "Weekly",
};

/**
 * One window as the app-server sends it. Field names captured from a live
 * `account/rateLimits/read` on 2026-09-04: `usedPercent`, `windowDurationMins`, and
 * `resetsAt` in epoch SECONDS. The snake_case spellings are accepted too, because the
 * protocol is unversioned and the cost of accepting both is one `??`.
 */
export interface CodexRateLimitWindow {
    usedPercent?: number;
    used_percent?: number;
    windowDurationMins?: number;
    window_duration_mins?: number;
    /** Epoch SECONDS, not milliseconds. */
    resetsAt?: number;
    resets_at?: number;
}

export interface CodexRateLimits {
    primary?: CodexRateLimitWindow | null;
    secondary?: CodexRateLimitWindow | null;
    planType?: string;
    plan_type?: string;
}

/** The whole `account/rateLimits/read` result. Other keys are ignored, never rejected. */
export interface CodexRateLimitsResult {
    rateLimits?: CodexRateLimits | null;
    rate_limits?: CodexRateLimits | null;
    accountId?: string;
}

/** The parts of `AppServerClient` a poll uses. Injected so tests never spawn a process. */
export interface CodexUsageClient {
    request<T>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): Promise<void>;
    close(): Promise<void>;
}

export interface CodexUsageDeps {
    /** Opens a client against one `CODEX_HOME`. Defaults to spawning `codex app-server`. */
    openClient?(home: string): Promise<CodexUsageClient>;
}

function pickNumber(...values: Array<number | undefined>): number | undefined {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }

    return undefined;
}

function toWindow(key: WindowKey, raw: CodexRateLimitWindow | null | undefined): LimitWindow | null {
    if (!raw) {
        return null;
    }

    const percentUsed = pickNumber(raw.usedPercent, raw.used_percent);

    if (percentUsed === undefined) {
        return null;
    }

    const durationMins = pickNumber(raw.windowDurationMins, raw.window_duration_mins);
    const resetsAtSeconds = pickNumber(raw.resetsAt, raw.resets_at);

    return {
        key,
        label: WINDOW_LABELS[key],
        kind: durationMins !== undefined && durationMins > WEEKLY_THRESHOLD_MINS ? "weekly" : "session",
        percentUsed,
        ...(durationMins === undefined ? {} : { periodMs: durationMins * 60_000 }),
        ...(resetsAtSeconds === undefined ? {} : { resetsAt: new Date(resetsAtSeconds * 1000).toISOString() }),
    };
}

/** `account/rateLimits/read` (or the `account/rateLimits/updated` push) to windows. */
export function mapRateLimits(result: CodexRateLimitsResult | null | undefined): {
    limits: LimitWindow[];
    planName?: string;
} {
    const rateLimits = result?.rateLimits ?? result?.rate_limits ?? null;

    if (!rateLimits) {
        return { limits: [] };
    }

    const limits: LimitWindow[] = [];

    for (const key of WINDOW_KEYS) {
        const window = toWindow(key, rateLimits[key]);

        if (window) {
            limits.push(window);
        }
    }

    const planName = rateLimits.planType ?? rateLimits.plan_type;

    return { limits, ...(planName === undefined ? {} : { planName }) };
}

/** The `CODEX_HOME` an account's credentials point at, or the CLI default. */
export function codexHomeFor(account: AccountEntry): string {
    const authFile = account.credentials.authFile;

    if (authFile) {
        return dirname(authFile);
    }

    return account.credentials.dataDir ?? join(homedir(), ".codex");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function spawnClient(home: string): Promise<CodexUsageClient> {
    const client = new AppServerClient(spawnAppServer({ cwd: home, home }));

    try {
        await withTimeout(
            client.request("initialize", {
                clientInfo: { name: "genesis-tools-usage", title: "GenesisTools usage", version: "0.1.0" },
                capabilities: null,
            }),
            REQUEST_TIMEOUT_MS,
            "codex app-server initialize"
        );
        await client.notify("initialized");
    } catch (err) {
        // `pollCodexAccount`'s finally only covers a client it received. A handshake that
        // times out throws before that, and the `codex app-server` child would survive
        // every failed poll, one process per minute.
        await client.close();
        throw err;
    }

    return client;
}

export async function pollCodexAccount(
    account: AccountEntry,
    _opts: UsagePollOptions = {},
    deps: CodexUsageDeps = {}
): Promise<AccountUsageSnapshot> {
    const fetchedAt = new Date().toISOString();
    const home = codexHomeFor(account);
    const base: AccountUsageSnapshot = {
        provider: "openai-sub",
        accountId: account.id,
        accountName: account.name,
        fetchedAt,
        limits: [],
        ...(account.label === undefined ? {} : { label: account.label }),
    };

    const open = deps.openClient ?? spawnClient;
    const client = await open(home);

    try {
        const result = await withTimeout(
            client.request<CodexRateLimitsResult>("account/rateLimits/read"),
            REQUEST_TIMEOUT_MS,
            "codex account/rateLimits/read"
        );
        logger.debug({ account: account.name, home, keys: Object.keys(result ?? {}) }, "[usage] codex rate limits");

        const { limits, planName } = mapRateLimits(result);

        if (limits.length === 0) {
            // No windows means the app-server has no account behind this home. It is a
            // login problem, not a transport one, so it is reported rather than thrown.
            return { ...base, error: "codex app-server reported no rate limits", auth: { reason: "not logged in" } };
        }

        return { ...base, limits, native: result, ...(planName === undefined ? {} : { plan: { name: planName } }) };
    } finally {
        // Always: an app-server left running holds a child process per poll, and the
        // daemon polls forever.
        await client.close();
    }
}

export const codexUsage: AccountUsageFeature = {
    poll: pollCodexAccount,
    minIntervalMs: MIN_INTERVAL_MS,
};
