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

function parse(raw: string | null): ClaritySession | null {
    if (!raw) {
        return null;
    }

    try {
        const item = SafeJSON.parse(raw, { strict: true }) as Partial<ClaritySession>;

        return item.authToken && item.sessionId
            ? { authToken: item.authToken, sessionId: item.sessionId, cookies: item.cookies }
            : null;
    } catch {
        return null;
    }
}

/** The session in AuthStorage (the macOS keychain, a 0600 file elsewhere). A session still in the config file moves here on the first read. */
export const authStorageSessionStore: ClaritySessionStore = {
    describe: () =>
        authStorageBackend().id === "macos-keychain"
            ? `the macOS keychain (encrypted), item ${ClaritySessionKey.service} / ${ClaritySessionKey.account}`
            : `AuthStorage (${authStorageBackend().id}), item ${ClaritySessionKey.service} / ${ClaritySessionKey.account}`,
    async read() {
        const saved = parse(await getAuthSecret(ClaritySessionKey));

        if (saved) {
            return saved;
        }

        const legacy = await fileSessionStore.read();

        if (legacy) {
            await setAuthSecret(ClaritySessionKey, SafeJSON.stringify(legacy));
            await fileSessionStore.clear();
        }

        return legacy;
    },
    async write(session) {
        await setAuthSecret(ClaritySessionKey, SafeJSON.stringify(session));
    },
    async clear() {
        await deleteAuthSecret(ClaritySessionKey);
        await fileSessionStore.clear();
    },
};
