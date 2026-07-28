import { randomBytes } from "node:crypto";
import { isInteractive } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { envKeyProvider, fileKeyProvider, masterKeyFilePath, securityStorage } from "./keyring/headless";
import { osKeyring } from "./keyring/os-keyring";
import { MASTER_KEY_BYTES, type MasterKeyProvider, type MasterKeySource } from "./keyring/types";

export class MasterKeyUnavailableError extends Error {
    constructor() {
        super(
            [
                "No vault master key available and this process is not interactive, so one cannot be generated safely.",
                `Provide it via ${env.security.getMasterKeyEnvKey()} (base64 of ${MASTER_KEY_BYTES} random bytes),`,
                `or enable the key file with {"allowKeyFile": true} in ${securityStorage().getConfigPath()} and place it at ${masterKeyFilePath()}.`,
            ].join(" ")
        );
        this.name = "MasterKeyUnavailableError";
    }
}

interface KeyState {
    key: Buffer;
    source: MasterKeySource;
}

let cached: KeyState | null = null;
let providers: MasterKeyProvider[] = [envKeyProvider, osKeyring, fileKeyProvider];

/**
 * Ladder, first hit wins: in-process cache, env, OS keychain, opt-in key file.
 * Interactive processes generate and store a key when every rung misses;
 * headless ones fail loudly rather than minting a key nobody can find later.
 *
 * The cache matters beyond speed: it caps every `tools` invocation at a single
 * keychain touch, which is what keeps macOS from prompting repeatedly.
 */
export async function masterKey(): Promise<Buffer> {
    if (cached) {
        return cached.key;
    }

    for (const provider of providers) {
        if (!(await provider.available())) {
            continue;
        }

        const key = await provider.get();
        if (key) {
            cached = { key, source: provider.id };
            logger.debug({ source: provider.id }, "resolved vault master key");
            return key;
        }
    }

    if (!isInteractive()) {
        throw new MasterKeyUnavailableError();
    }

    const generated = randomBytes(MASTER_KEY_BYTES);
    const writable = providers.find((p) => p.id !== "env");
    if (!writable) {
        throw new MasterKeyUnavailableError();
    }

    await writable.set(generated);
    cached = { key: generated, source: writable.id };
    logger.info({ source: writable.id }, "generated a new vault master key");
    return generated;
}

export async function masterKeySource(): Promise<MasterKeySource | undefined> {
    if (cached) {
        return cached.source;
    }

    for (const provider of providers) {
        if (await provider.available()) {
            const key = await provider.get();
            if (key) {
                cached = { key, source: provider.id };
                return provider.id;
            }
        }
    }

    return undefined;
}

export function invalidateMasterKeyCache(): void {
    cached = null;
}

/** Test seam: swap the ladder for fakes. Production code never calls this. */
export function _setMasterKeyProvidersForTest(next: MasterKeyProvider[]): void {
    providers = next;
    cached = null;
}

export function _resetMasterKeyProviders(): void {
    providers = [envKeyProvider, osKeyring, fileKeyProvider];
    cached = null;
}
