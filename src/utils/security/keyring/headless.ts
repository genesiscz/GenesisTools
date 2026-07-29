import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { decodeMasterKey, MASTER_KEY_BYTES, type MasterKeyProvider } from "./types";

/**
 * Env rung. The only path that works for a launchd daemon started before login
 * or over SSH, where the login keychain is locked and unreachable.
 */
class EnvKeyProvider implements MasterKeyProvider {
    readonly id = "env" as const;

    async available(): Promise<boolean> {
        return env.security.getMasterKey() !== undefined;
    }

    async get(): Promise<Buffer | undefined> {
        return this.getSync();
    }

    getSync(): Buffer | undefined {
        return decodeMasterKey(env.security.getMasterKey(), "env");
    }

    async set(): Promise<void> {
        throw new Error(
            `Cannot write ${env.security.getMasterKeyEnvKey()} from the process. Export it in the shell or the launchd plist instead.`
        );
    }
}

export function securityStorage(): Storage {
    return new Storage("security");
}

export function masterKeyFilePath(): string {
    return `${securityStorage().getBaseDir()}/master.key`;
}

export interface SecurityLocalConfig {
    allowKeyFile?: boolean;
    /** Epoch ms of the last vault export. Drives `doctor`'s escrow nag. */
    lastExportAt?: number;
}

async function securityConfig(): Promise<SecurityLocalConfig> {
    const config = await securityStorage().getConfig<SecurityLocalConfig>();
    return config ?? {};
}

/**
 * When the vault was last escrowed to a passphrase-protected export.
 *
 * A vault with no export is one keychain loss away from unrecoverable, so
 * `doctor` asks this and nags, rather than the user discovering it the hard way.
 */
export async function lastVaultExportAt(): Promise<number | undefined> {
    return (await securityConfig()).lastExportAt;
}

export async function recordVaultExport(at: number = Date.now()): Promise<void> {
    const storage = securityStorage();

    await storage.withConfigLock(async () => {
        const current = (await storage.getConfig<SecurityLocalConfig>()) ?? {};
        await storage.setConfig({ ...current, lastExportAt: at });
    });

    logger.debug({ at }, "recorded vault export timestamp");
}

/**
 * Key-file rung, opt-in only (`allowKeyFile: true` in security/config.json).
 * Plaintext at rest by definition, so it stays off unless the user chooses it
 * for a headless box that has no keychain at all.
 */
class FileKeyProvider implements MasterKeyProvider {
    readonly id = "file" as const;

    async available(): Promise<boolean> {
        const config = await securityConfig();
        return config.allowKeyFile === true;
    }

    async get(): Promise<Buffer | undefined> {
        if (!(await this.available())) {
            return undefined;
        }

        const path = masterKeyFilePath();
        if (!existsSync(path)) {
            return undefined;
        }

        return decodeMasterKey(readFileSync(path, "utf8"), "file");
    }

    async set(key: Buffer): Promise<void> {
        if (!(await this.available())) {
            throw new Error(
                `Key file storage is disabled. Set {"allowKeyFile": true} in ${securityStorage().getConfigPath()} to enable it.`
            );
        }

        if (key.length !== MASTER_KEY_BYTES) {
            throw new Error(`Master key must be ${MASTER_KEY_BYTES} bytes, got ${key.length}.`);
        }

        const path = masterKeyFilePath();
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, key.toString("base64"), { mode: 0o600 });
        chmodSync(path, 0o600);
        logger.warn({ path }, "vault master key written to a plaintext key file (opt-in)");
    }
}

export const envKeyProvider: MasterKeyProvider = new EnvKeyProvider();
export const fileKeyProvider: MasterKeyProvider = new FileKeyProvider();
