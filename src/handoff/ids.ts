import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(length: number): string {
    const bytes = randomBytes(length);
    let out = "";

    for (let i = 0; i < length; i++) {
        out += ALPHABET[bytes[i] % ALPHABET.length];
    }

    return out;
}

export function generateHandoffId(): string {
    return `h_${randomSuffix(8)}`;
}

export function generateEditId(): string {
    return `he_${randomSuffix(8)}`;
}

export function generateAttachmentId(): string {
    return `a_${randomSuffix(8)}`;
}

export function generateEventUid(): string {
    return randomSuffix(12);
}

/** Id tolerance (§5): `h_` prefix optional, whitespace trimmed. */
export function normalizeHandoffId(raw: string): string {
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
        return trimmed;
    }

    return trimmed.startsWith("h_") ? trimmed : `h_${trimmed}`;
}

/** Same tolerance for edit credentials (`he_` prefix optional). */
export function normalizeEditId(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw.trim();

    if (trimmed.length === 0) {
        return undefined;
    }

    return trimmed.startsWith("he_") ? trimmed : `he_${trimmed}`;
}
