import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";

/**
 * WHICH credentials an account holds, never their values (spec 13.3). A
 * `SecureRef` in the config is already a pointer, but printing it would still
 * name a vault path, and `--json` output ends up in logs and pastes.
 */
export type CredentialKind =
    | "apiKey"
    | "accessToken"
    | "refreshToken"
    | "longLivedToken"
    | "secondary"
    | "authFile"
    | "dataDir";

const KINDS: CredentialKind[] = [
    "apiKey",
    "accessToken",
    "refreshToken",
    "longLivedToken",
    "secondary",
    "authFile",
    "dataDir",
];

export function credentialKinds(account: AccountEntry): CredentialKind[] {
    return KINDS.filter((kind) => account.credentials[kind] !== undefined);
}
