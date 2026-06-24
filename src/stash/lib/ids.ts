import { randomBytes } from "node:crypto";

// Time-ordered 32-hex ID (48-bit ms timestamp + 80 bits random) — preserves SQLite index ordering without needing crypto.randomUUID.
export function newStashId(): string {
    const now = BigInt(Date.now());
    const tsHex = now.toString(16).padStart(12, "0");
    const rand = randomBytes(10).toString("hex");
    return tsHex + rand;
}

export function shortId(id: string): string {
    return id.slice(0, 6);
}
