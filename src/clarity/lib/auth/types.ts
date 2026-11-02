/** What the Clarity API needs on every request, besides the base URL. */
export interface ClaritySession {
    authToken: string;
    sessionId: string;
    cookies?: string;
}

export interface ClarityAuth extends ClaritySession {
    baseUrl: string;
}

export interface ClarityAuthDriver {
    /** Saved in the config as `auth.driver` and accepted by `--driver`. */
    id: string;
    label: string;
    /** Interactive sign-in. Throws a message the user can act on. */
    signIn(previous: { baseUrl?: string }): Promise<ClarityAuth>;
    /** Sign in again without asking anything. Absent when the driver cannot. */
    renew?(previous: { baseUrl?: string }): Promise<ClarityAuth>;
    /** The account `renew` would sign in as, or null when it has none saved. Shown before a one-click sign-in. */
    identity?(): Promise<string | null>;
}

/** Where the session lives. The config file holds the base URL, the user and the mappings only. */
export interface ClaritySessionStore {
    /** Where it is kept, in words a user can check. */
    describe(): string;
    read(): Promise<ClaritySession | null>;
    write(session: ClaritySession): Promise<void>;
    clear(): Promise<void>;
}
