export interface ClarityAuth {
    baseUrl: string;
    authToken: string;
    sessionId: string;
    cookies: string;
}

export interface ClarityAuthDriver {
    /** Saved in the config as `auth.driver` and accepted by `--driver`. */
    id: string;
    label: string;
    /** Interactive sign-in. Throws a message the user can act on. */
    signIn(previous: { baseUrl?: string }): Promise<ClarityAuth>;
    /** Sign in again without asking anything. Absent when the driver cannot. */
    renew?(previous: { baseUrl: string }): Promise<ClarityAuth>;
}
