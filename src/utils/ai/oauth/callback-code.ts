import * as p from "@clack/prompts";
import type { CallbackListener } from "./callback-server";
import { type AuthorizationInteraction, type AuthorizationUrlAction, readAuthorizationCode } from "./login-ui";

/** One message for every way a callback can fail to belong to this login. */
const MISMATCHED_STATE =
    "OAuth callback state does not match this login. Paste the callback from the current authorization.";

/**
 * The one `state` comparison a browser login makes, from both halves: the loopback
 * listener refuses a foreign callback without settling, and the paste prompt
 * refuses one before the exchange.
 *
 * `required` is the difference between them. The listener demands `state`,
 * because a real provider callback always carries it and one without it is some
 * other local process reaching a loopback port. The paste prompt does not,
 * because pasting a bare code with no `#state` is a legitimate thing a user
 * does and has to keep working.
 */
export function callbackStateError(
    state: string | undefined,
    expected: string | null,
    options: { required?: boolean } = {}
): string | undefined {
    if (state === undefined) {
        return options.required ? MISMATCHED_STATE : undefined;
    }

    if (state === expected) {
        return undefined;
    }

    return MISMATCHED_STATE;
}

/**
 * The authorization code, from whichever half of the flow produced it.
 *
 * The listener wins when it is up and the user actually sent a browser at the
 * URL. `none` means they already hold a code from an earlier authorization, and
 * an empty-handed listener (its deadline passed, or the browser finished against
 * the vendor CLI's own listener) hands the terminal back to the paste prompt
 * that was the entire flow before the listener existed.
 */
export async function readCallbackCode(input: {
    listener: CallbackListener | null;
    action: AuthorizationUrlAction;
    interaction: AuthorizationInteraction | undefined;
    expectedState: string | null;
}): Promise<string> {
    if (input.listener && input.action !== "none") {
        const waiting = p.spinner();
        waiting.start("Waiting for the browser to finish authorizing...");
        const callback = await input.listener.callback;

        if (callback !== null && "error" in callback) {
            waiting.stop("The browser callback was refused.");
            throw new Error(callback.error);
        }

        if (callback !== null) {
            waiting.stop("Authorized in the browser.");
            return callback.code;
        }

        waiting.stop("No callback arrived. Paste the code from the browser instead.");
    }

    const normalized = await readAuthorizationCode(input.interaction);

    if (normalized === null) {
        throw new Error("Cancelled");
    }

    if ("error" in normalized) {
        throw new Error(normalized.error);
    }

    const [code, state] = normalized.code.split("#");
    const mismatch = callbackStateError(state, input.expectedState);

    if (mismatch) {
        throw new Error(mismatch);
    }

    return code;
}
