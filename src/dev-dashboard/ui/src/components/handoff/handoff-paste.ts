export interface UploadedAttachment {
    attachmentId: string;
}

/**
 * Insert `insert` into `prev` at `cursor`, clamping the cursor to the current
 * length. The clamp matters when the draft shrank during the async upload gap
 * (user edited/cleared it, or the composer remounted for another handoff) — a
 * stale cursor past the end would otherwise splice text at the wrong offset.
 */
export function insertAtCursor(prev: string, insert: string, cursor: number): string {
    const at = Math.min(Math.max(0, cursor), prev.length);
    return `${prev.slice(0, at)}${insert}${prev.slice(at)}`;
}

/**
 * Fold `Promise.allSettled` upload results into the `[File#id]` token string for
 * every fulfilled upload plus the first rejection (if any). Successful uploads
 * still produce their tokens even when a sibling upload fails.
 */
export function collectUploadTokens(results: PromiseSettledResult<UploadedAttachment>[]): {
    tokens: string;
    failure: PromiseRejectedResult | undefined;
} {
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<UploadedAttachment> => r.status === "fulfilled");
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    const tokens = fulfilled.map((r) => `[File#${r.value.attachmentId}]`).join(" ");
    return { tokens, failure };
}
