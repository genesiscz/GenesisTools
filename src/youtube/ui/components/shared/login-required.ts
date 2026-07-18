/** Stable server code for "you must sign in" (server auth.ts `requireUser`). */
export const LOGIN_REQUIRED_CODE = "login_required";

const LOGIN_REQUIRED_MESSAGE = "login required";

/** String `code` off an error-like object (ApiError, coded Error), else undefined. */
export function errorCodeOf(error: unknown): string | undefined {
    if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code?: unknown }).code;

        return typeof code === "string" ? code : undefined;
    }

    return undefined;
}

/** Code-first check with legacy message fallback — new servers send
 *  `code: "login_required"`, older ones only the message string. */
export function isLoginRequiredError(error: unknown): boolean {
    if (!error) {
        return false;
    }

    if (errorCodeOf(error) === LOGIN_REQUIRED_CODE) {
        return true;
    }

    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";

    return message === LOGIN_REQUIRED_MESSAGE;
}
