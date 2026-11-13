import { fileSessionStore } from "@app/clarity/lib/auth/file-session-store";
import type { ClaritySession, ClaritySessionStore } from "@app/clarity/lib/auth/types";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type AuthStorageKey,
    authStorageBackend,
    deleteAuthSecret,
    getAuthSecret,
    setAuthSecret,
} from "@genesiscz/utils/storage/AuthStorage";

/** The keychain item both this tool and its downstream copies read, so one sign-in serves them all. */
export const ClaritySessionKey: AuthStorageKey = { service: "genesis-tools-clarity", account: "session" };

interface StoredSession extends ClaritySession {
    /** The server the session signs in to (`https://host[:port]`), so a copy set up for another server never sends it. */
    origin?: string;
}

/** The scheme, host and port of a base URL, or null for one that does not parse. */
export function clarityOrigin(baseUrl: string): string | null {
    try {
        return new URL(baseUrl).origin;
    } catch {
        return null;
    }
}

function parse(raw: string | null, baseUrl: string): ClaritySession | null {
    if (!raw) {
        return null;
    }

    try {
        const item = SafeJSON.parse(raw, { strict: true }) as Partial<StoredSession>;
        const origin = clarityOrigin(baseUrl);

        // An item saved for another server is not this server's session. An item saved before the item named its
        // server (no `origin`) is the configured server's: readers accept the old shape, and the next sign-in
        // writes the origin (a read never writes).
        return item.authToken &&
            item.sessionId &&
            origin !== null &&
            (item.origin === undefined || item.origin === origin)
            ? { authToken: item.authToken, sessionId: item.sessionId, cookies: item.cookies }
            : null;
    } catch {
        return null;
    }
}

/**
 * The session in AuthStorage (the macOS keychain, a 0600 file elsewhere), bound to the server it signs in to. A session
 * still in the config file is read from there as it is; the next sign-in moves it (a read never writes, because
 * `configure show` and the status endpoints read it).
 */
export const authStorageSessionStore: ClaritySessionStore = {
    describe: () =>
        authStorageBackend().id === "macos-keychain"
            ? `the macOS keychain (encrypted), item ${ClaritySessionKey.service} / ${ClaritySessionKey.account}`
            : `AuthStorage (${authStorageBackend().id}), item ${ClaritySessionKey.service} / ${ClaritySessionKey.account}`,
    async read(baseUrl) {
        return parse(await getAuthSecret(ClaritySessionKey), baseUrl) ?? (await fileSessionStore.read(baseUrl));
    },
    async write(session, baseUrl) {
        const origin = clarityOrigin(baseUrl);

        if (origin === null) {
            throw new Error(`"${baseUrl}" is not a Clarity server URL; the session is saved for one server only.`);
        }

        const stored: StoredSession = { ...session, origin };
        await setAuthSecret(ClaritySessionKey, SafeJSON.stringify(stored));
    },
    async clear() {
        await deleteAuthSecret(ClaritySessionKey);
        await fileSessionStore.clear();
    },
};
