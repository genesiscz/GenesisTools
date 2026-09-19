/** Statuses every speech provider treats as final: the request itself is wrong, so a retry repeats it. */
const NEVER_RETRY = [400, 401, 403, 404] as const;

/**
 * Whether a failed speech synthesis is worth retrying.
 *
 * Three providers each carried their own copy of this, identical but for the status list, and
 * they had already drifted: ElevenLabs added 422 and the other two never got it. A provider that
 * rejects a request for one more reason passes that status here rather than forking the rule.
 *
 * The check reads the error's MESSAGE because the SDKs surface the status inside it rather than
 * as a field. That is imprecise by nature, so it is written once where it can be improved once.
 */
export function shouldRetrySynthesize(error: unknown, alsoFinal: readonly number[] = []): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const statuses = [...NEVER_RETRY, ...alsoFinal];

    return !new RegExp(`\\b(${statuses.join("|")})\\b`).test(message);
}
