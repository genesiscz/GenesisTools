import { randomBytes } from "node:crypto";

// Time-ordered 32-hex ID (48-bit ms timestamp + 80 bits random) — preserves SQLite index ordering without needing crypto.randomUUID.
export function newStashId(): string {
    const now = BigInt(Date.now());
    const tsHex = now.toString(16).padStart(12, "0");
    const rand = randomBytes(10).toString("hex");
    return tsHex + rand;
}

// Use the LAST 6 chars (random suffix), not the first 6. PR #222 t16: the first 6 hex chars are
// the high 24 bits of a 48-bit ms timestamp and only flip every 2^24 ms ≈ 4.66 hours, so every
// stash created within the same ~5-hour window has the SAME shortId — defeating its purpose as
// a user-facing disambiguator. The trailing 24 bits come from `randomBytes(10)`, so they vary
// per ID with effectively zero collision risk at the scale of personal stashes.
export function shortId(id: string): string {
    return id.slice(-6);
}
