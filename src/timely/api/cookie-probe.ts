import { type SaveCookieResult, saveCookie } from "@app/timely/utils/cookie";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";

/** Never let a stalled network leave `login cookies` waiting with no output. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Why a candidate cookie was refused. They need different wording, because
 * "rejected" alone sends the user looking for the wrong mistake.
 */
export type CookieRejection =
    /** A redirect, which is how the web host bounces an unauthenticated request to sign-in. */
    | "redirected"
    /** Any status other than a plain 200, including the other 2xx codes. */
    | "http-status"
    /** 200, but not the JSON array suggested_entries returns — the sign-in page answers like this. */
    | "not-suggested-entries";

export type CookieProbeOutcome =
    | { status: "saved"; saved: SaveCookieResult }
    | { status: "rejected"; httpStatus: number; reason: CookieRejection }
    | { status: "unreachable"; error: unknown };

export interface ProbeAndSaveCookieOptions {
    storage: Storage;
    accountId: number;
    cookie: string;
}

/**
 * The rule that makes `login cookies` safe to paste into: a candidate credential
 * reaches disk only after Timely serves real suggested-entries JSON in answer to
 * a request carrying it. A cookie that is expired, truncated by a half-copied
 * clipboard, or simply wrong is refused here, so it never becomes a stored
 * credential that fails later as an unexplained 401.
 *
 * It fails closed on purpose, because a signed-out request to a WEB host does not
 * come back as a 401 — it comes back as a redirect to a sign-in page, or as a 200
 * carrying that page's HTML. Both look like success to `response.ok`, so neither
 * `ok` nor a followed redirect can be trusted as proof of anything here.
 *
 * The outcome is returned rather than printed, so the caller owns the wording and
 * the exit code while this stays one testable unit. The value is a credential: it
 * is sent, and never logged or echoed.
 */
export async function probeAndSaveCookie(options: ProbeAndSaveCookieOptions): Promise<CookieProbeOutcome> {
    const { storage, accountId, cookie } = options;
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://app.timelyapp.com/${accountId}/suggested_entries.json?date=${today}&spam=true`;

    let response: Response;

    try {
        response = await fetch(url, {
            headers: { accept: "application/json", Cookie: cookie },
            // Following the bounce to sign-in would turn a dead cookie into a 200.
            redirect: "manual",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    } catch (error) {
        logger.debug({ error, url }, "[login] the cookie probe could not reach Timely; nothing saved");
        return { status: "unreachable", error };
    }

    const reason = await rejectionFor(response);

    if (reason) {
        logger.debug(
            { httpStatus: response.status, reason, url },
            "[login] Timely did not accept the pasted cookie; nothing saved"
        );

        return { status: "rejected", httpStatus: response.status, reason };
    }

    logger.debug("[login] Timely served suggested entries for the pasted cookie; storing it");

    return { status: "saved", saved: await saveCookie(storage, cookie) };
}

/** Undefined only when the response is a genuine, authenticated suggested_entries payload. */
async function rejectionFor(response: Response): Promise<CookieRejection | undefined> {
    if (response.status >= 300 && response.status < 400) {
        return "redirected";
    }

    if (response.status !== 200) {
        return "http-status";
    }

    const body = await response.text();

    try {
        // suggested_entries answers with a JSON array, empty on a day with no memories.
        // The sign-in page is HTML, and an error payload is an object, so both fail here.
        return Array.isArray(SafeJSON.parse(body, { strict: true })) ? undefined : "not-suggested-entries";
    } catch (error) {
        logger.debug(
            { error, bodyPrefix: body.slice(0, 120) },
            "[login] the probe answered 200 with a body that is not JSON"
        );

        return "not-suggested-entries";
    }
}
