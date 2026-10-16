import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { APICallError, RetryError } from "ai";
import { usageFromQuotaHeaders } from "./quota-headers";

export type AnthropicFailureKind = "org-oauth-blocked" | "terms-update" | "weekly-limit" | "session-limit";

export interface AnthropicFailure {
    kind: AnthropicFailureKind;
    /** One sentence for a report line. */
    message: string;
    /** What a person has to do; absent when nothing they can do changes it. */
    action?: string;
}

/** The SDK wraps a retried 429 or 5xx in a `RetryError`; the API answer is its last error. */
function apiError(err: unknown): APICallError | undefined {
    const inner = RetryError.isInstance(err) ? err.lastError : err;
    return APICallError.isInstance(inner) ? inner : undefined;
}

/**
 * Name the refusals an Anthropic subscription account answers with that no retry or fallback
 * token changes (measured 2026-10-16 on the account list: a 403 `oauth_not_allowed_for_organization`,
 * a 400 asking for the updated Consumer Terms, a 429 with the weekly window at 100 %). Anything else
 * is not recognised, so the caller surfaces the original error unchanged.
 */
export function describeAnthropicFailure(err: unknown): AnthropicFailure | undefined {
    const error = apiError(err);

    if (!error) {
        return undefined;
    }

    const body = error.responseBody ?? error.message;

    if (
        error.statusCode === 403 &&
        /oauth_not_allowed_for_organization|not allowed for this organization/i.test(body)
    ) {
        return {
            kind: "org-oauth-blocked",
            message: "HTTP 403: Anthropic refuses OAuth for this organization",
            action: "Only the organization owner or Anthropic can allow it.",
        };
    }

    if (error.statusCode === 400 && /Consumer Terms/i.test(body)) {
        return {
            kind: "terms-update",
            message: "HTTP 400: Anthropic wants the updated Consumer Terms accepted",
            action: "Sign in at claude.ai with this account's email and accept them.",
        };
    }

    if (error.statusCode === 429 && error.responseHeaders) {
        const usage = usageFromQuotaHeaders(new Headers(error.responseHeaders));

        for (const [kind, label, bucket] of [
            ["weekly-limit", "weekly", usage?.seven_day],
            ["session-limit", "5-hour", usage?.five_hour],
        ] as const) {
            if (bucket && bucket.utilization >= 100) {
                const resets = bucket.resets_at
                    ? `, resets ${formatLocalDateTimeStamp(bucket.resets_at, { seconds: false })}`
                    : "";
                return { kind, message: `${label} limit used up${resets}` };
            }
        }
    }

    return undefined;
}
