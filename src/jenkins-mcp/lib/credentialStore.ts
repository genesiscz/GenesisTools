/**
 * Where the Jenkins login is kept in GenesisTools.
 *
 * This file is the seam. The rest of the login flow (credentials.ts, login.ts)
 * was written in a sibling internal repo (commit c7c38efcc8) and ported here
 * unchanged apart from the command name, because everything else already
 * imports `@genesiscz/utils/*`. Only secret storage differs between the two
 * trees, so only this file is rewritten.
 *
 * WHICH GENESISTOOLS MODULE, AND WHY. `secrets()` from
 * `@genesiscz/utils/security` — the AES-256-GCM vault at
 * `~/.genesis-tools/security/vault.json`, per-entry key via HKDF, written under
 * a file lock. It is the repo's documented credential store (CLAUDE.md, layer
 * L0) and every AI account credential already lives in it.
 *
 * The two alternatives lose something this needs:
 *
 * - `keyring/os-keyring.ts` is one RUNG BENEATH the vault: it holds the single
 *   master key, not per-tool secrets. Writing a second item there would put
 *   Jenkins outside `tools ai config secret export|import` and outside the
 *   master-key rotation, and it would add another `gt-<tool>` keychain identity
 *   to prompt on (see the keychain-identity note in the CPU-hog campaign).
 * - `storage/AuthStorage.ts` is OAuth token bookkeeping, not an opaque secret.
 *
 * ONE BLOB, NOT A KEY/VALUE MAP. `SECRET_PATH` holds the whole
 * `{version, defaultHost, hosts}` object: URL, username and token together, for
 * every host. Spreading the fields across vault paths would let a half-written
 * login leave a token whose URL says something else, and every reader would
 * have to reimplement the same bookkeeping. `credentials.test.ts` asserts the
 * write count for exactly this reason.
 *
 * ONE DELIBERATE SIGNATURE CHANGE. Upstream `secretStoreAvailable()` is
 * synchronous. Here it returns a promise, because the sync answer this repo can
 * give (`masterKeySync()`) only asks providers that implement `getSync`, so a
 * keyring rung that is perfectly available reads as absent. A false "this
 * platform has no secret store" points the user at the wrong fix, which is the
 * exact failure this whole port exists to remove. Both callers already await.
 */
import { logger } from "@genesiscz/utils/logger";
import { masterKeySource, secrets } from "@genesiscz/utils/security";

/** Kept for parity with the upstream file, so a future re-port diffs cleanly. */
export const SECRET_SERVICE = "jenkins";

/** The single entry. There is exactly one; its value holds every host. */
export const SECRET_ACCOUNT = "credentials";

/** The vault path both of the above compose into. */
export const SECRET_PATH = `${SECRET_SERVICE}/${SECRET_ACCOUNT}`;

export function secretStoreName(): string {
    return "the GenesisTools vault";
}

/**
 * Availability means "a master key rung can answer", not "a file exists": the
 * vault itself is created on first write. `masterKeySource()` walks the ladder
 * (env, OS keyring, opt-in key file) and returns undefined when none answers,
 * which is the headless case the caller has to report instead of crashing.
 *
 * It reads only. A diagnostic that reached this must not mint or rotate a key.
 */
export async function secretStoreAvailable(): Promise<boolean> {
    try {
        return (await masterKeySource()) !== undefined;
    } catch (error) {
        logger.debug({ error }, "jenkins: no master key rung answered, treating the vault as unavailable");
        return false;
    }
}

export async function readVault(): Promise<string | null> {
    try {
        const store = await secrets();
        return (await store.get(SECRET_PATH)) ?? null;
    } catch (error) {
        // A locked or unreadable vault is "no stored login" for the caller, but
        // it is never silent: without this line the only symptom is a setup
        // message telling the user to log in again when they already had.
        logger.warn({ error, path: SECRET_PATH }, "jenkins: could not read the stored login from the vault");
        return null;
    }
}

export async function writeVault(value: string): Promise<boolean> {
    try {
        const store = await secrets();
        await store.set(SECRET_PATH, value);
        return true;
    } catch (error) {
        logger.warn({ error, path: SECRET_PATH }, "jenkins: the vault refused the write");
        return false;
    }
}

export async function clearVault(): Promise<boolean> {
    try {
        const store = await secrets();
        return await store.delete(SECRET_PATH);
    } catch (error) {
        logger.warn({ error, path: SECRET_PATH }, "jenkins: the vault refused the delete");
        return false;
    }
}
