export function isAuthHttpStatus(status: number): boolean {
    return status === 401 || status === 403;
}

/**
 * Statuses that say the PROVIDER is unwell rather than this account.
 *
 * They arrive identically for every account in the same round and they clear up on their
 * own, so the usage poll gate treats them like a dead network (a five minute ceiling)
 * instead of climbing the account ladder to a six hour block that outlives the outage.
 * 401, 403 and 429 are deliberately absent: those ARE account facts and keep the long
 * ladder, which is the whole reason the two ladders were split.
 */
export function isUpstreamOutageStatus(status: number): boolean {
    return status === 408 || status === 425 || status >= 500;
}

/**
 * A status the provider answered with, kept ON the error so a classifier never has to
 * parse a message. `statusCode` is spelled as `RetryableApiError` spells it, so the two
 * read the same way at a catch site.
 */
export class UpstreamStatusError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "UpstreamStatusError";
        this.statusCode = statusCode;
    }
}
