import { resolveAnthropicSubModel } from "@genesiscz/utils/ai/anthropic/models";
import { MODEL_ROLES } from "@genesiscz/utils/ai/catalog/roles";
import { UpstreamStatusError } from "@genesiscz/utils/ai/http-auth";
import {
    CC_VERSION,
    SUBSCRIPTION_BETAS,
    SUBSCRIPTION_SYSTEM_PREFIX,
} from "@genesiscz/utils/claude/subscription-billing";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import type { ApiLimit, UsageBucket, UsageResponse } from "./api";
import { type ProbeBudget, persistedProbeBudget } from "./probe-budget";

/**
 * Usage read from the rate-limit headers of an inference response instead of `/api/oauth/usage`.
 *
 * Every `/v1/messages` answer carries `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}`;
 * Claude Code reads them (and sends its own `max_tokens: 1` "quota" request at startup). It works with
 * the long-lived `sk-ant-oat01-` token, which the usage endpoint refuses (no `user:profile` scope),
 * and it has no 5-requests-per-access-token cap, so reading it spends no refresh grant.
 *
 * Measured 2026-09-27: `max_tokens: 0` is accepted (HTTP 200, 0 output tokens) with every header,
 * `count_tokens` returns none, and the values equal the endpoint's (0.23 / 0.39 against 23 % / 39 %,
 * resets within a second). The Fable weekly window comes as `7d_oi` ("seven_day_overage_included",
 * Claude Code's "Fable limit"), and only on the answer of a Fable-model request that looks like Claude
 * Code (its system prompt, the claude-code beta, client version 2.1.251 or newer); otherwise the server
 * answers 400, or 429 with no headers. That request costs 34 input tokens.
 *
 * The usage endpoint stays the primary source (it alone returns extra usage, spend and the other scoped
 * limits); a header reading is a fallback laid over the last endpoint reading.
 */

/**
 * How often a header reading asks the Fable model while the account is idle; the cheap probe in between keeps
 * the last Fable window.
 */
export const FABLE_READING_INTERVAL_MS = 30 * 60_000;
/**
 * While an account is in use (its last reading moved the 5-hour or the weekly window), every header reading
 * asks the Fable model instead of the cheap one, so the Fable window is as fresh as the other two. Martin's
 * condition (2026-11-10): only while the Fable probe is known to cost fewer tokens than this. The cost is read
 * from the probe's own answer (`quota.fableProbeTokens`), never assumed. Measured 2026-11-10 on
 * claude-fable-5-2: 34 input tokens and 0 output tokens; the cheap probe costs 22.
 */
export const FABLE_PROBE_TOKEN_LIMIT = 100;

export const QUOTA_PROBE_URL = "https://api.anthropic.com/v1/messages";
/** The only model whose answer carries the Fable window. */
export const QUOTA_PROBE_MODEL = resolveAnthropicSubModel("fable");
/**
 * The cheap probe: the 5-hour and weekly windows, without Fable. Also the fallback for an account the
 * Fable model refuses.
 */
export const QUOTA_PROBE_FALLBACK_MODEL = MODEL_ROLES.anthropic.probe;
/**
 * Probes allowed per account and model in 7 days. Martin's rule (2026-09-28): the probes may cost at most
 * 1 % of a weekly limit. A probe is about 34 input tokens. The poll reads the headers every 2 minutes (5,040
 * readings a week), and each reading is ONE probe: the cheap model, or the Fable model when the Fable window
 * is due (`fableReadingDue`). Until 2026-11-10 Fable was asked only every 30 minutes (336 a week, cap 400).
 * Since then an account in use asks Fable on every reading, so both caps sit a little above the number of
 * readings in a week: at most about 204k input tokens of either model ($0.20 of Haiku, $1.63 of Fable 5.2 at
 * list price) for an account that is in use around the clock. A lower Fable cap would stop the whole reading
 * of a busy account, because a spent budget skips the reading.
 */
export const WEEKLY_PROBE_CAPS: Readonly<Record<string, number>> = {
    [QUOTA_PROBE_FALLBACK_MODEL]: 6_000,
    [QUOTA_PROBE_MODEL]: 6_000,
};
const QUOTA_PROBE_TIMEOUT_MS = 20_000;
const HEADER = "anthropic-ratelimit-unified";
/** Starts the message of every failed header reading, so a recorded failure names its source. */
const FAILURE_PREFIX = "Quota headers";
/** The name Claude Code gives the `7d_oi` window when the endpoint names no single scoped limit. */
const OVERAGE_INCLUDED_MODEL = "Fable";

/** What the headers say besides the windows; kept on the reading as `quota`. */
export interface QuotaHeaderStatus {
    source: "headers";
    status: string | null;
    fiveHourStatus: string | null;
    sevenDayStatus: string | null;
    /** The Fable window's status; null when the answer did not carry that window. */
    fableStatus: string | null;
    representativeClaim: string | null;
    overageStatus: string | null;
    /** When the endpoint reading this one keeps the other limits from was taken (ISO). */
    endpointAsOf?: string;
    /** When the Fable window was last read (ISO); a cheap probe keeps the window of that reading. */
    fableReadAt?: string;
    /**
     * What the last Fable probe was billed, in tokens (input, cache and output), read from its answer. Absent
     * until one answer carried a usage block; a later reading keeps the last measurement.
     */
    fableProbeTokens?: number;
    /** The 5-hour or the weekly window differs from the reading before this one: the account is in use. */
    moved?: boolean;
}

function bucket(headers: Headers, window: "5h" | "7d" | "7d_oi"): UsageBucket | null {
    const raw = headers.get(`${HEADER}-${window}-utilization`);

    if (raw === null || raw.trim() === "" || !Number.isFinite(Number(raw))) {
        return null;
    }

    const reset = Number(headers.get(`${HEADER}-${window}-reset`));
    return {
        // A fraction in the header, a percent in the endpoint's answer.
        utilization: Math.round(Number(raw) * 1000) / 10,
        resets_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
    };
}

/** The unified headers in the usage endpoint's shape; null when the response carries neither window. */
export function usageFromQuotaHeaders(headers: Headers): UsageResponse | null {
    const fiveHour = bucket(headers, "5h");
    const sevenDay = bucket(headers, "7d");
    const fable = bucket(headers, "7d_oi");

    if (!fiveHour && !sevenDay) {
        return null;
    }

    const quota: QuotaHeaderStatus = {
        source: "headers",
        status: headers.get(`${HEADER}-status`),
        fiveHourStatus: headers.get(`${HEADER}-5h-status`),
        sevenDayStatus: headers.get(`${HEADER}-7d-status`),
        fableStatus: headers.get(`${HEADER}-7d_oi-status`),
        representativeClaim: headers.get(`${HEADER}-representative-claim`),
        overageStatus: headers.get(`${HEADER}-overage-status`),
    };

    return {
        // No 5h headers beside the weekly ones: the account has no 5-hour limit (since 2026-10-31; an idle
        // account with one still gets them, 0 % with a reset 5 hours out). Never a made-up 0 % window.
        five_hour: fiveHour,
        seven_day: sevenDay ?? { utilization: 0, resets_at: null },
        ...(fable ? { seven_day_overage_included: fable } : {}),
        quota,
    };
}

/** The reading came from the headers (not the usage endpoint). */
export function isHeaderReading(usage: UsageResponse | undefined): boolean {
    const quota = usage?.quota as Partial<QuotaHeaderStatus> | undefined;
    return quota?.source === "headers";
}

/** When the endpoint reading behind a header reading was taken (ISO); undefined when there is none. */
export function endpointAsOf(usage: UsageResponse | undefined): string | undefined {
    const quota = usage?.quota as Partial<QuotaHeaderStatus> | undefined;
    return quota?.source === "headers" ? quota.endpointAsOf : undefined;
}

/**
 * The next header reading should ask the Fable model: no Fable reading yet, the last one is 30 minutes old, or
 * the account is in use and the Fable probe is proven cheap (`FABLE_PROBE_TOKEN_LIMIT`). An unmeasured probe
 * is not a cheap one, so without a measurement the 30-minute rule alone decides.
 */
export function fableReadingDue(previous: UsageResponse | undefined, now: number): boolean {
    const quota = previous?.quota as Partial<QuotaHeaderStatus> | undefined;
    const readAt = quota?.source === "headers" && quota.fableReadAt ? Date.parse(quota.fableReadAt) : Number.NaN;

    if (!Number.isFinite(readAt) || now - readAt >= FABLE_READING_INTERVAL_MS) {
        return true;
    }

    const tokens = quota?.fableProbeTokens;

    return quota?.moved === true && typeof tokens === "number" && tokens < FABLE_PROBE_TOKEN_LIMIT;
}

/** A recorded poll failure came from a header reading (an org refusal, a revoked long-lived token). */
export function isQuotaHeaderFailure(reason: string): boolean {
    return reason.includes(`${FAILURE_PREFIX} `);
}

function severityOf(status: string | null): string {
    if (status === "rejected") {
        return "critical";
    }

    return status === "allowed_warning" ? "warning" : "normal";
}

/** The `representative-claim` value that makes each kind the binding limit. */
const CLAIM_OF_KIND: Record<string, string> = {
    session: "five_hour",
    weekly_all: "seven_day",
    weekly_scoped: "seven_day_overage_included",
};

function limitFrom(args: {
    kind: "session" | "weekly_all" | "weekly_scoped";
    window: UsageBucket;
    status: string | null;
    quota: QuotaHeaderStatus;
    model?: string;
}): ApiLimit {
    return {
        kind: args.kind,
        group: args.kind === "session" ? "session" : "weekly",
        percent: args.window.utilization,
        severity: severityOf(args.status),
        resets_at: args.window.resets_at,
        scope: args.model ? { model: { id: null, display_name: args.model }, surface: null } : null,
        is_active: args.quota.representativeClaim === CLAIM_OF_KIND[args.kind],
    };
}

/** Claude Code's rule: the endpoint's single scoped limit names the window, else it is Fable. */
function fableModelName(limits: readonly ApiLimit[]): string {
    const scoped = limits.filter((limit) => limit.kind === "weekly_scoped" && limit.scope?.model?.display_name);
    return (scoped.length === 1 ? scoped[0].scope?.model?.display_name : null) ?? OVERAGE_INCLUDED_MODEL;
}

function sameLimit(a: ApiLimit, b: ApiLimit): boolean {
    return a.kind === b.kind && (a.scope?.model?.display_name ?? null) === (b.scope?.model?.display_name ?? null);
}

function keptFrom(previous: UsageResponse): Partial<UsageResponse> {
    // `quota_capped_token` came from an earlier build that skipped the endpoint after its cap.
    const { quota_capped_token: _capped, ...kept } = previous;
    return kept;
}

/**
 * A header reading laid over the last endpoint reading. The headers answer the 5-hour, weekly and Fable
 * windows; everything else the endpoint returns (extra usage, spend, the weekly breakdown, other scoped
 * limits) is kept from that reading, and `quota.endpointAsOf` says when it was taken. A cheap probe
 * carries no Fable window, so the last header reading's Fable window stays, with `quota.fableReadAt`.
 * The result always carries a `limits` list, because `normalizeLimits` reads that list over the flat windows.
 * The headers alone decide whether the 5-hour window exists: without it the result has `five_hour: null`
 * and no `session` entry, not even the one the kept endpoint reading had, whose numbers would read as live.
 */
export function mergeHeaderReading(
    fresh: UsageResponse,
    previous: UsageResponse | undefined,
    previousFetchedAt: number | undefined,
    now: number = Date.now()
): UsageResponse {
    const previousQuota = previous?.quota as Partial<QuotaHeaderStatus> | undefined;
    const freshFable = fresh.seven_day_overage_included;
    const keptFable =
        !freshFable && previousQuota?.source === "headers" ? previous?.seven_day_overage_included : undefined;
    const fableReadAt = freshFable ? new Date(now).toISOString() : keptFable ? previousQuota?.fableReadAt : undefined;
    const fableProbeTokens =
        (fresh.quota as QuotaHeaderStatus).fableProbeTokens ??
        (previousQuota?.source === "headers" ? previousQuota.fableProbeTokens : undefined);
    const moved =
        previous !== undefined &&
        (fresh.five_hour?.utilization !== previous.five_hour?.utilization ||
            fresh.seven_day.utilization !== previous.seven_day?.utilization);
    const quota: QuotaHeaderStatus = {
        ...(fresh.quota as QuotaHeaderStatus),
        ...(keptFable ? { fableStatus: previousQuota?.fableStatus ?? null } : {}),
        ...(fableReadAt ? { fableReadAt } : {}),
        ...(fableProbeTokens === undefined ? {} : { fableProbeTokens }),
        ...(moved ? { moved: true } : {}),
    };
    const endpointAsOf =
        previousQuota?.source === "headers"
            ? previousQuota.endpointAsOf
            : previous && previousFetchedAt !== undefined
              ? new Date(previousFetchedAt).toISOString()
              : undefined;
    const endpoint = previous && endpointAsOf !== undefined ? keptFrom(previous) : {};
    const fable = freshFable ?? keptFable;
    const fiveHour = fresh.five_hour;
    const base = Array.isArray(endpoint.limits)
        ? endpoint.limits.filter((limit) => fiveHour || limit.kind !== "session")
        : [];
    const updates = [
        ...(fiveHour ? [limitFrom({ kind: "session", window: fiveHour, status: quota.fiveHourStatus, quota })] : []),
        limitFrom({ kind: "weekly_all", window: fresh.seven_day, status: quota.sevenDayStatus, quota }),
        ...(fable
            ? [
                  limitFrom({
                      kind: "weekly_scoped",
                      window: fable,
                      status: quota.fableStatus,
                      quota,
                      model: fableModelName(base),
                  }),
              ]
            : []),
    ];
    const limits = [
        ...base.map((limit) => {
            const update = updates.find((candidate) => sameLimit(candidate, limit));
            // The endpoint's group and scope (with the model id) stay; the numbers are the headers'.
            return update ? { ...update, group: limit.group ?? update.group, scope: limit.scope } : limit;
        }),
        ...updates.filter((update) => !base.some((limit) => sameLimit(update, limit))),
    ];

    return {
        ...endpoint,
        ...fresh,
        ...(fable ? { seven_day_overage_included: fable } : {}),
        limits,
        quota: endpointAsOf === undefined ? quota : { ...quota, endpointAsOf },
    };
}

function sendQuotaProbe(
    token: string,
    model: string,
    opts: { signal: AbortSignal; fetchImpl?: typeof fetch }
): Promise<Response> {
    return (opts.fetchImpl ?? fetch)(QUOTA_PROBE_URL, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "anthropic-beta": SUBSCRIPTION_BETAS,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "user-agent": `claude-cli/${CC_VERSION} (external, cli)`,
        },
        body: SafeJSON.stringify({
            model,
            max_tokens: 0,
            system: [{ type: "text", text: SUBSCRIPTION_SYSTEM_PREFIX }],
            messages: [{ role: "user", content: "quota" }],
        }),
        signal: opts.signal,
    });
}

/**
 * What a probe was billed, from the usage block of its answer: input, cache and output tokens together.
 * Undefined when the answer has no usage block (a 429, a body that is not JSON), so a caller never takes an
 * unmeasured probe for a cheap one.
 */
async function probeTokens(res: Response, tag: string): Promise<number | undefined> {
    try {
        const body: unknown = SafeJSON.parse(await res.text(), { strict: true });
        const usage = isObject(body) && isObject(body.usage) ? body.usage : null;

        if (!usage || typeof usage.input_tokens !== "number") {
            return undefined;
        }

        const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

        return (
            count(usage.input_tokens) +
            count(usage.cache_creation_input_tokens) +
            count(usage.cache_read_input_tokens) +
            count(usage.output_tokens)
        );
    } catch (err) {
        logger.debug({ err }, `${tag} quota headers: the probe answer has no readable usage block`);
        return undefined;
    }
}

/**
 * One `max_tokens: 0` request, read for its headers: to the Fable model when the Fable window is wanted,
 * else to the cheap model. A second one to the cheap model only when the Fable model is refused without
 * headers. A 429 that carries the windows is a reading (the account is at a limit), not a failure.
 * Anything else without headers throws, with the body in the message, so an org-level refusal is still
 * classified. Every request is charged to the account's probe budget first, and a spent budget throws
 * before anything is sent.
 */
export async function fetchUsageFromHeaders(
    token: string,
    opts: {
        account: string;
        withFable?: boolean;
        signal?: AbortSignal;
        fetchImpl?: typeof fetch;
        budget?: ProbeBudget;
    }
): Promise<UsageResponse> {
    const tag = `[usage:${opts.account}]`;
    const budget = opts.budget ?? persistedProbeBudget(opts.account, WEEKLY_PROBE_CAPS);
    const deadline = AbortSignal.timeout(QUOTA_PROBE_TIMEOUT_MS);
    const probe = {
        signal: opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline,
        fetchImpl: opts.fetchImpl,
    };
    const model = opts.withFable === false ? QUOTA_PROBE_FALLBACK_MODEL : QUOTA_PROBE_MODEL;
    await budget.spend(model);
    let asked = model;
    let res = await sendQuotaProbe(token, model, probe);

    if (model === QUOTA_PROBE_MODEL && [400, 404, 429].includes(res.status) && !usageFromQuotaHeaders(res.headers)) {
        const refusal = await res.text().catch(() => "");
        logger.debug(
            `${tag} quota headers: ${QUOTA_PROBE_MODEL} answered ${res.status} (${refusal.slice(0, 160)}); asking ${QUOTA_PROBE_FALLBACK_MODEL}`
        );
        await budget.spend(QUOTA_PROBE_FALLBACK_MODEL);
        asked = QUOTA_PROBE_FALLBACK_MODEL;
        res = await sendQuotaProbe(token, QUOTA_PROBE_FALLBACK_MODEL, probe);
    }

    const usage = usageFromQuotaHeaders(res.headers);

    if (usage && (res.ok || res.status === 429)) {
        // Only the Fable probe is measured: its cost is what `fableReadingDue` must be sure of.
        const fableProbeTokens = asked === QUOTA_PROBE_MODEL ? await probeTokens(res, tag) : undefined;
        logger.debug(
            {
                status: res.status,
                model: asked,
                fiveHour: usage.five_hour?.utilization ?? null,
                sevenDay: usage.seven_day.utilization,
                fable: usage.seven_day_overage_included?.utilization ?? null,
                ...(fableProbeTokens === undefined ? {} : { fableProbeTokens }),
            },
            `${tag} usage read from the rate-limit headers`
        );
        await res.body?.cancel().catch(() => undefined);

        return fableProbeTokens === undefined
            ? usage
            : { ...usage, quota: { ...(usage.quota as QuotaHeaderStatus), fableProbeTokens } };
    }

    const body = await res.text().catch(() => "");
    logger.warn(`${tag} quota headers: HTTP ${res.status} without a reading: ${body.slice(0, 200)}`);
    throw new UpstreamStatusError(res.status, `${FAILURE_PREFIX} ${res.status}: ${body.slice(0, 200)}`);
}
