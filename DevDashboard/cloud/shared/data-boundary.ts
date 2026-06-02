/**
 * The non-negotiable data boundary (D11). Every persistence write into a cloud table goes
 * through `assertNoKeyMaterial`, which enforces two invariants:
 *
 *   1. No FORBIDDEN_KEY_FIELDS (private/secret/session key material) may appear on any record.
 *   2. Every field on the record must be in that table's CLOUD_PERSISTABLE_FIELDS allow-list.
 *
 * The E2E crypto itself lives entirely on the two endpoints (phone + Mac agent) — see plan 02.
 * The cloud never holds private keys, derived session secrets, or the pairing secret.
 */

import { CLOUD_PERSISTABLE_FIELDS, type CloudTable } from "./account-model";

/** Field names that, if present on a cloud-bound record, mean a private secret is leaking. */
export const FORBIDDEN_KEY_FIELDS = [
    "privateKey",
    "secretKey",
    "sessionKey",
    "sharedSecret",
    "derivedSecret",
    "pairingSecret",
    "symmetricKey",
    "aeadKey",
    "nonceSecret",
] as const;

export type CloudRecord = Record<string, unknown>;

/**
 * Throws if `record` would persist private key material or any field outside the table's
 * allow-list. Call this on every write into a cloud table. Returns the record (typed back to
 * the caller) on success so it can be used inline: `store.insert(assertNoKeyMaterial("accounts", row))`.
 */
export function assertNoKeyMaterial<T extends CloudRecord>(table: CloudTable, record: T): T {
    const allowed = new Set<string>(CLOUD_PERSISTABLE_FIELDS[table]);
    const forbidden = new Set<string>(FORBIDDEN_KEY_FIELDS);

    for (const key of Object.keys(record)) {
        if (forbidden.has(key)) {
            throw new Error(`data-boundary violation: field "${key}" is private key material and must never reach the cloud (table ${table})`);
        }

        if (!allowed.has(key)) {
            throw new Error(`data-boundary violation: field "${key}" is not permitted on cloud table "${table}" (allow-list: ${[...allowed].join(", ")})`);
        }
    }

    return record;
}
