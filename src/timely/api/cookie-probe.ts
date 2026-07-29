import { type SaveCookieResult, saveCookie } from "@app/timely/utils/cookie";
import { logger } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";

/** Never let a stalled network leave `login cookies` waiting with no output. */
const PROBE_TIMEOUT_MS = 15_000;

export type CookieProbeOutcome =
    | { status: "saved"; saved: SaveCookieResult }
    | { status: "rejected"; httpStatus: number }
    | { status: "unreachable"; error: unknown };

export interface ProbeAndSaveCookieOptions {
    storage: Storage;
    accountId: number;
    cookie: string;
}

/**
 * The rule that makes `login cookies` safe to paste into: a candidate credential
 * reaches disk only after Timely answers 200 to a real request carrying it. A
 * cookie that is expired, truncated by a half-copied clipboard, or simply wrong
 * is refused here, so it never becomes a stored credential that fails later as an
 * unexplained 401.
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
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    } catch (error) {
        logger.debug({ error, url }, "[login] the cookie probe could not reach Timely; nothing saved");
        return { status: "unreachable", error };
    }

    if (!response.ok) {
        logger.debug({ httpStatus: response.status, url }, "[login] Timely rejected the pasted cookie; nothing saved");
        return { status: "rejected", httpStatus: response.status };
    }

    logger.debug("[login] Timely accepted the pasted cookie; storing it");

    return { status: "saved", saved: await saveCookie(storage, cookie) };
}
