export const VAULT_VERSION = 1;

/** HKDF salt. Bumping this invalidates every entry, so it is versioned with the format. */
export const VAULT_HKDF_SALT = "genesis-vault-v1";

export interface VaultEntry {
    /** base64, 12 random bytes, fresh per write. */
    iv: string;
    /** base64 ciphertext. */
    ct: string;
    /** base64, 16-byte GCM tag. */
    tag: string;
    updatedAt: number;
}

export interface VaultFile {
    version: number;
    kdf: "hkdf-sha256";
    entries: Record<string, VaultEntry>;
}

export function emptyVault(): VaultFile {
    return { version: VAULT_VERSION, kdf: "hkdf-sha256", entries: {} };
}
