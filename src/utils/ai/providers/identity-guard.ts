/**
 * A login flow decides WHICH account authorizes in the browser, not the CLI.
 * So `tools claude login <name>` with a stale browser session can complete as
 * a different person and overwrite that entry's tokens — silently, because
 * every later call then succeeds under the wrong identity.
 *
 * An unprovable identity is NOT a mismatch: when either uuid is missing there
 * is nothing to compare, and refusing there would block first-time logins.
 */
export function identityMismatch(input: { storedUuid?: string; incomingUuid?: string }): boolean {
    if (!input.storedUuid || !input.incomingUuid) {
        return false;
    }

    return input.storedUuid !== input.incomingUuid;
}
