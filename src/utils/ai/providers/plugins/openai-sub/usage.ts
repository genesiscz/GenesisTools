import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { AccountEntry } from "../../../config/schema";
import { CodexAccountBinding } from "../../../openai/account-binding";
import { buildAccountLaunchOptions } from "../../../openai/account-launch-options";
import { AppServerClient, spawnAppServer } from "../../../openai/app-server-client";
import { fileMtimeMs } from "../../../usage-poll/credential-stamp";
import type { AccountUsageFeature, AccountUsageSnapshot, LimitWindow, UsagePollOptions } from "../../account-features";

/**
 * `accounts.usage` for the Codex (ChatGPT plan) subscription (spec 2026-09-04 section 6.6).
 *
 * The Codex CLI reports rate limits only over its app-server, so one poll starts a short
 * lived isolated `codex app-server`, supplies the selected account's external tokens,
 * asks `account/rateLimits/read` and stops it. The 120s floor bounds process overhead.
 * File references are read-only. Vault grants have one shared refresh owner; probes
 * never refresh tokens, including through an app-server callback.
 */

const MIN_INTERVAL_MS = 120_000;

const REQUEST_TIMEOUT_MS = 10_000;

/** Anything longer than a day is the weekly window; the 5h one is the session window. */
const WEEKLY_THRESHOLD_MINS = 24 * 60;

/** The two window slots the app-server names, in display order. */
const WINDOW_KEYS = ["primary", "secondary"] as const;

type WindowKey = (typeof WINDOW_KEYS)[number];

/**
 * The slot is not the window: a Pro plan without a 5h window reports its WEEKLY limit
 * as `primary` and no `secondary` at all (cdx account observed 2026-09-10: primary =
 * 10080 min, secondary = null), so labelling by slot drew "Session 48%" over a weekly
 * limit. Duration decides; the slot is only the fallback for a window that carries none.
 */
const SLOT_FALLBACK_KIND: Record<WindowKey, "session" | "weekly"> = {
    primary: "session",
    secondary: "weekly",
};

const KIND_LABELS = { session: "5h", weekly: "Weekly" } as const;

function windowKind(key: WindowKey, durationMins: number | undefined): "session" | "weekly" {
    if (durationMins === undefined) {
        return SLOT_FALLBACK_KIND[key];
    }

    return durationMins > WEEKLY_THRESHOLD_MINS ? "weekly" : "session";
}

/** `GPT-5.3-Codex-Spark` fits a 16-cell label column as `Spark`; the full name stays in `scopeModel`. */
function shortScopeName(limitName: string): string {
    return limitName.split("-").at(-1) || limitName;
}

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
    /** `codex` for the plan-wide limit; a per-model limit names its model (`codex_bengalfox`). */
    limitId?: string | null;
    /** Display name of a per-model limit (`GPT-5.3-Codex-Spark`); null on the plan-wide one. */
    limitName?: string | null;
    primary?: CodexRateLimitWindow | null;
    secondary?: CodexRateLimitWindow | null;
    planType?: string;
    plan_type?: string;
}

/** The plan-wide limit id, the one `rateLimits` repeats, when a payload does not name it. */
const DEFAULT_LIMIT_ID = "codex";

/** The whole `account/rateLimits/read` result. Other keys are ignored, never rejected. */
export interface CodexRateLimitsResult {
    rateLimits?: CodexRateLimits | null;
    rate_limits?: CodexRateLimits | null;
    /**
     * Every limit the account has, keyed by limit id, the plan-wide one included. Models
     * with their own pool (Spark, 2026-09-10) appear only here, so reading `rateLimits`
     * alone silently drops them.
     */
    rateLimitsByLimitId?: Record<string, CodexRateLimits | null> | null;
    accountId?: string;
}

/** The parts of `AppServerClient` a poll uses. Injected so tests never spawn a process. */
export interface CodexUsageClient {
    request<T>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): Promise<void>;
    close(): Promise<void>;
}

export interface CodexUsageDeps {
    /** Opens an isolated client already authenticated to this account. */
    openClient?(account: AccountEntry, options: UsagePollOptions): Promise<CodexUsageClient>;
    /** Process boundary for protocol/lifecycle tests; production uses the shared spawner. */
    spawnProcess?: typeof spawnAppServer;
}

function pickNumber(...values: Array<number | undefined>): number | undefined {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }

    return undefined;
}

interface WindowScope {
    limitId: string;
    limitName: string;
}

function toWindow(
    key: WindowKey,
    raw: CodexRateLimitWindow | null | undefined,
    scope?: WindowScope
): LimitWindow | null {
    if (!raw) {
        return null;
    }

    const percentUsed = pickNumber(raw.usedPercent, raw.used_percent);

    if (percentUsed === undefined) {
        return null;
    }

    const durationMins = pickNumber(raw.windowDurationMins, raw.window_duration_mins);
    // An untouched window carries `resetsAt = now + window`, re-stamped on every read: a
    // placeholder, not a running clock (observed 2026-09-10: 19:20:22, 19:22:36, 19:24:55
    // for the same 0% window). Dropping it lets every consumer treat the window as idle,
    // the way anthropic's missing `resets_at` already does, instead of counting down a
    // reset that never comes.
    const resetsAtSeconds = percentUsed === 0 ? undefined : pickNumber(raw.resetsAt, raw.resets_at);
    const kind = windowKind(key, durationMins);

    return {
        ...(scope
            ? {
                  key: `${key}:${scope.limitId}`,
                  label: `${KIND_LABELS[kind]} ${shortScopeName(scope.limitName)}`,
                  kind: "scoped" as const,
                  scopeModel: scope.limitName,
              }
            : { key, label: KIND_LABELS[kind], kind }),
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

    const defaultLimitId = rateLimits.limitId ?? DEFAULT_LIMIT_ID;

    for (const [limitId, scoped] of Object.entries(result?.rateLimitsByLimitId ?? {})) {
        if (limitId === defaultLimitId || !scoped) {
            continue;
        }

        const scope: WindowScope = { limitId, limitName: scoped.limitName ?? limitId };

        for (const key of WINDOW_KEYS) {
            const window = toWindow(key, scoped[key], scope);

            if (window) {
                limits.push(window);
            }
        }
    }

    const planName = rateLimits.planType ?? rateLimits.plan_type;

    return { limits, ...(planName === undefined ? {} : { planName }) };
}

/**
 * The `CODEX_HOME` this account is BOUND to, or null when it names none.
 *
 * There is no default. An account may hold its own `accessToken`/`refreshToken` with no
 * `authFile` and no `dataDir` (`codex-auth.ts` supports that credential mode), and falling
 * back to `~/.codex` then read a DIFFERENT login's rate limits and filed them under this
 * account's id and name — every such account showing the same numbers (review t9). It is
 * also the ambient credential pickup the house rules forbid.
 */
export function codexHomeFor(account: AccountEntry): string | null {
    const authFile = account.credentials.authFile;

    if (authFile) {
        return dirname(authFile);
    }

    return account.credentials.accessToken ? null : (account.credentials.dataDir ?? null);
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

const USAGE_HOME_PREFIX = "gt-codex-usage-";

/**
 * Ephemeral homes THIS process created and has not finished with.
 *
 * `cleanup` removes each one on the normal path, but it never runs when the process is
 * killed, and this one is killed routinely: `src/daemon/lib/runner.ts` SIGTERMs the whole
 * task tree once a round passes its 60s budget, which a laptop waking mid-poll reaches every
 * time. Ten abandoned Codex homes, 12 MB of sqlite, had collected by 2026-09-11.
 */
const liveHomes = new Set<string>();

/**
 * Age past which a leftover home belongs to a run that is gone.
 *
 * One poll lives for a handshake plus a single `account/rateLimits/read` (10s ceiling), and
 * the floor between polls is 120s, so an hour is far outside any live run. That margin is the
 * point: a `tools ai usage` or `tools codex usage` in another terminal keeps its own home in
 * this same directory, and sweeping it out from under that process would break a poll the
 * user is watching.
 */
const ABANDONED_HOME_MS = 60 * 60 * 1000;

/** Ceiling on one sweep, so a pathological temp directory cannot stall a poll. */
const MAX_SWEEP = 50;

let sweptThisProcess = false;

/** Once per process: the daemon is a fresh process per round, so that is still every round. */
async function sweepOnce(root: string): Promise<void> {
    if (sweptThisProcess) {
        return;
    }

    sweptThisProcess = true;
    await sweepAbandonedHomes(root);
}

/**
 * Remove `gt-codex-usage-*` directories older than {@link ABANDONED_HOME_MS} and answer how
 * many went.
 *
 * Exported because the age rule is the only thing standing between this sweep and the live
 * home of a `tools ai usage` running in another terminal, so both halves of it need a test:
 * an abandoned home goes, a fresh one stays.
 */
export async function sweepAbandonedHomes(root: string): Promise<number> {
    let names: string[];

    try {
        names = await readdir(root);
    } catch (err) {
        logger.debug({ err, root }, "[usage] could not list the temp root to sweep codex homes");
        return 0;
    }

    let removed = 0;

    for (const name of names) {
        if (removed >= MAX_SWEEP || !name.startsWith(USAGE_HOME_PREFIX)) {
            continue;
        }

        const dir = join(root, name);

        if (liveHomes.has(dir)) {
            continue;
        }

        try {
            const age = Date.now() - (await stat(dir)).mtimeMs;

            if (age < ABANDONED_HOME_MS) {
                continue;
            }

            await rm(dir, { recursive: true, force: true });
            removed += 1;
        } catch (err) {
            logger.debug({ err, dir }, "[usage] an abandoned codex home could not be removed");
        }
    }

    if (removed > 0) {
        logger.info({ removed, root }, "[usage] removed abandoned codex usage homes");
    }

    return removed;
}

/**
 * Remove every ephemeral home this process still owns, for a signal handler, where `cleanup`
 * never gets its turn. Only this process's own homes: a concurrent poll in another terminal
 * owns its own, and both live in the same directory.
 */
export async function releaseCodexUsageHomes(): Promise<void> {
    const homes = [...liveHomes];
    liveHomes.clear();

    await Promise.all(
        homes.map((home) =>
            rm(home, { recursive: true, force: true }).catch((err: unknown) =>
                logger.debug({ err, home }, "[usage] could not release an ephemeral codex home")
            )
        )
    );
}

async function spawnClient(
    account: AccountEntry,
    options: UsagePollOptions,
    spawnProcess: typeof spawnAppServer = spawnAppServer
): Promise<CodexUsageClient> {
    const binding = await CodexAccountBinding.create(account.id, { allowRefresh: !options.probe });
    // Resolve first: expired diagnostic credentials must fail before any vendor process starts.
    const tokens = await binding.tokens({ refresh: !options.probe });
    const root = tmpdir();

    await sweepOnce(root);

    const home = await mkdtemp(join(root, USAGE_HOME_PREFIX));

    liveHomes.add(home);
    let client: AppServerClient | undefined;
    const cleanup = async () => {
        await client?.close();
        if (client) {
            try {
                await withTimeout(client.process.exited, 2000, "codex usage shutdown");
            } catch {
                client.process.kill("SIGKILL");
                await withTimeout(client.process.exited, 2000, "codex usage forced shutdown");
            }
        }
        // This directory was created exclusively for this poll, never supplied by a user.
        liveHomes.delete(home);
        await rm(home, { recursive: true, force: true });
    };

    try {
        client = new AppServerClient(
            spawnProcess(buildAccountLaunchOptions({ sharedHome: home, cwd: home, accountName: account.name })),
            {
                onServerRequest: async (request) => {
                    if (request.method !== "account/chatgptAuthTokens/refresh" || options.probe) {
                        throw new Error("Account refresh is unavailable during this usage request");
                    }
                    const params = request.params as { previousAccountId?: string | null } | undefined;
                    return binding.refresh(params?.previousAccountId ?? null);
                },
            }
        );
        await withTimeout(
            client.request("initialize", {
                clientInfo: { name: "genesis-tools-usage", title: "GenesisTools usage", version: "0.1.0" },
                capabilities: { experimentalApi: true },
            }),
            REQUEST_TIMEOUT_MS,
            "codex app-server initialize"
        );
        await client.notify("initialized");
        const result = await withTimeout(
            client.request<{ type: string }>("account/login/start", { type: "chatgptAuthTokens", ...tokens }),
            REQUEST_TIMEOUT_MS,
            "codex account authentication"
        );
        if (result.type !== "chatgptAuthTokens") {
            throw new Error("Codex did not accept the selected account's external credentials");
        }
    } catch (err) {
        // `pollCodexAccount`'s finally only covers a client it received. A handshake that
        // times out throws before that, and the `codex app-server` child would survive
        // every failed poll, one process per minute.
        await cleanup();
        throw err;
    }

    const ready = client;
    return {
        request: (method, params) => ready.request(method, params),
        notify: (method, params) => ready.notify(method, params),
        close: cleanup,
    };
}

export async function pollCodexAccount(
    account: AccountEntry,
    opts: UsagePollOptions = {},
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

    if (home === null && !account.credentials.accessToken) {
        // Reported, not thrown: an unbound account is a configuration state, not a failure
        // that should climb the poll gate's backoff ladder.
        logger.debug({ account: account.name }, "[usage] codex account names no home; not polling the CLI default");

        return {
            ...base,
            error: "no Codex home bound to this account — run: tools codex login --home <dir>",
            auth: { reason: "no codex home bound" },
        };
    }

    const open = deps.openClient ?? ((selected, options) => spawnClient(selected, options, deps.spawnProcess));
    let client: CodexUsageClient;

    try {
        client = await open(account, opts);
    } catch (err) {
        // `Bun.spawn` on a missing `codex` binary, or on a CODEX_HOME that no longer
        // exists, throws a bare ENOENT naming `posix_spawn`. That reached the dashboard
        // card verbatim and told the reader nothing about what to do next. `cause` is kept
        // so the poll gate still sees a handshake deadline underneath.
        throw new Error(
            // A vault-backed account has no native home at all, and `for null` read as a bug in
            // the message rather than the intended "this account carries its own grant".
            `Could not start "codex app-server" for ${home ?? `account ${account.name}`}: ` +
                `${err instanceof Error ? err.message : err}. ` +
                "Check the Codex CLI is installed and re-login with: tools codex login <account>",
            { cause: err }
        );
    }

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

/**
 * `codex login` rewrites `auth.json` inside the account's `CODEX_HOME`. The app-server
 * reads that same file, so its stamp is exactly "when was this account last repaired".
 *
 * An account bound to no home has nothing to stat: `codexHomeFor` returns null there rather
 * than falling back to `~/.codex`, and a stamp read from a different login's file would
 * release this account's gate on somebody else's re-login.
 */
export async function codexCredentialStamp(account: AccountEntry): Promise<number | undefined> {
    const home = codexHomeFor(account);

    if (!home) {
        return account.credentials.expiresAt;
    }

    return fileMtimeMs(account.credentials.authFile ?? join(home, "auth.json"));
}

export const codexUsage: AccountUsageFeature = {
    poll: pollCodexAccount,
    minIntervalMs: MIN_INTERVAL_MS,
    credentialStamp: codexCredentialStamp,
};
