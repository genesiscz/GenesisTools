export { masterKeyFilePath, securityStorage } from "./keyring/headless";
export type { MasterKeyProvider, MasterKeySource } from "./keyring/types";
export { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, MASTER_KEY_BYTES } from "./keyring/types";
export {
    _resetMasterKeyProviders,
    _setMasterKeyProvidersForTest,
    invalidateMasterKeyCache,
    MasterKeyUnavailableError,
    masterKey,
    masterKeySource,
} from "./MasterKey";
export { _resetSecretsForTest, redactSecrets, resolveSecret, type SecretStore, secrets } from "./SecretStore";
export { exportVault, importVault, rotateMasterKey, type VaultExportBlob } from "./vault-admin";
export { isSecretPath, isSecureRef, type MaybeSecret, type SecureRef, secureRef } from "./SecureRef";
export { VAULT_VERSION, type VaultEntry, type VaultFile } from "./vault-format";
