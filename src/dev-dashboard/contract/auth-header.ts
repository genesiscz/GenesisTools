// Pure Basic-Auth header codec. No `node:crypto` — only base64 string work, so it
// is safe to bundle into the React Native (Hermes) app. The password VERIFIERS
// (scrypt/hmac/timing-safe compare) stay in `lib/auth.ts`; only the encode/parse
// pair lives here because the mobile client must build the `Authorization` header.

export interface BasicAuthInput {
    username: string;
    password: string;
}

function toBase64Utf8(raw: string): string {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(raw, "utf8").toString("base64");
    }

    const bytes = new TextEncoder().encode(raw);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}

function fromBase64Utf8(encoded: string): string {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(encoded, "base64").toString("utf8");
    }

    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/** Build the `Basic <base64(user:pass)>` header. UTF-8 safe for non-ASCII passwords. */
export function makeBasicAuthHeader(input: BasicAuthInput): string {
    return `Basic ${toBase64Utf8(`${input.username}:${input.password}`)}`;
}

/** Parse a `Basic …` header back to its parts, or null if malformed / not Basic. */
export function parseBasicAuthHeader(header: string | null): BasicAuthInput | null {
    if (!header || !/^basic\s+/i.test(header)) {
        return null;
    }

    const encoded = header.replace(/^basic\s+/i, "").trim();
    let decoded: string;
    try {
        decoded = fromBase64Utf8(encoded);
    } catch {
        return null;
    }
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex < 1) {
        return null;
    }

    return {
        username: decoded.slice(0, separatorIndex),
        password: decoded.slice(separatorIndex + 1),
    };
}
