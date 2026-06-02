import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

// The managed-tier pairing ADMISSION control. `/api/e2e/pair` stores public keys only, but
// without this an attacker who can reach the Agent — including the untrusted vendor relay —
// could self-pair its own key and defeat the "we can't see your data" guarantee (the trust
// anchor is the pairing, not the cipher). So a new device may only be admitted if it presents
// a short-lived, one-time code shown on the Mac (out-of-band TOFU). High entropy (32^8 ≈ 1.1e12)
// + a 5-minute window + one-time consume makes online guessing through the relay infeasible.
//
// NOTE: against an ACTIVE malicious relay that observes the plaintext code in transit, the
// complementary defence is the safety-number (SAS) check after pairing — see the managed-tier
// follow-up. This module is the admission gate; SAS is the MITM detector.

const CODE_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "pairing-code.json");
const DEFAULT_TTL_MS = 5 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — unambiguous to read + type
const CODE_LENGTH = 8;

interface PairingCodeRecord {
    code: string;
    expiresAt: number;
}

/** A short, human-typeable, unambiguous pairing code (e.g. "K7P2M9QX"). */
export function generatePairingCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let code = "";

    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }

    return code;
}

/** Persist an active pairing code (0600). Returns the absolute expiry timestamp (ms). */
export async function savePairingCode(
    code: string,
    now: number = Date.now(),
    ttlMs: number = DEFAULT_TTL_MS,
    path: string = CODE_PATH
): Promise<number> {
    const expiresAt = now + ttlMs;
    await Bun.write(path, SafeJSON.stringify({ code, expiresAt } satisfies PairingCodeRecord, null, 2));
    chmodSync(path, 0o600);

    return expiresAt;
}

/**
 * Verify a candidate code against the active record and CONSUME it (one-time) on success.
 * Returns true only for an exact match within the validity window. Wrong guesses do NOT consume
 * (so a legitimate user can retry), but the code's entropy makes brute force infeasible.
 */
export async function verifyAndConsumePairingCode(
    candidate: string,
    now: number = Date.now(),
    path: string = CODE_PATH
): Promise<boolean> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        return false;
    }

    let record: PairingCodeRecord;

    try {
        record = SafeJSON.parse(await file.text(), { strict: true }) as PairingCodeRecord;
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: unreadable pairing-code file — rejecting pair");
        return false;
    }

    const valid =
        typeof record.code === "string" &&
        record.code.length > 0 &&
        record.code === candidate &&
        now < record.expiresAt;

    if (valid) {
        // Invalidate (one-time use) by overwriting with an already-expired empty record. We never
        // delete the file — an empty/expired record can never validate again and avoids a missing-file race.
        await Bun.write(path, SafeJSON.stringify({ code: "", expiresAt: 0 } satisfies PairingCodeRecord, null, 2));
    }

    return valid;
}
