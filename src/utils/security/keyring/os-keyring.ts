import { logger } from "@genesiscz/utils/logger";
import { Entry } from "@napi-rs/keyring";
import { decodeMasterKey, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, type MasterKeyProvider } from "./types";

/**
 * OS keychain rung, via `@napi-rs/keyring` on every platform (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service).
 *
 * Uniform-binary access is the whole point: macOS grants silent reads by CODE
 * SIGNATURE, so the same `bun` that wrote the item reads it back without a GUI
 * prompt, while a different binary (`security`, another app) gets prompted.
 * Mixing in the `security` CLI here would reintroduce exactly that prompt.
 * Verified empirically 2026-07-29: napi write then fresh-process napi read
 * returned in 0.049s with no prompt, while `security find-generic-password` for
 * the same item returned nothing.
 */
class OsKeyring implements MasterKeyProvider {
    readonly id = "keychain" as const;

    async available(): Promise<boolean> {
        try {
            this.entry();
            return true;
        } catch (err) {
            logger.debug({ err }, "OS keyring unavailable");
            return false;
        }
    }

    async get(): Promise<Buffer | undefined> {
        try {
            return decodeMasterKey(this.entry().getPassword(), "keychain");
        } catch (err) {
            logger.debug({ err }, "no master key in OS keyring");
            return undefined;
        }
    }

    async set(key: Buffer): Promise<void> {
        this.entry().setPassword(key.toString("base64"));
        logger.info({ service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT }, "stored vault master key in OS keyring");
    }

    private entry(): Entry {
        return new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    }
}

export const osKeyring: MasterKeyProvider = new OsKeyring();
