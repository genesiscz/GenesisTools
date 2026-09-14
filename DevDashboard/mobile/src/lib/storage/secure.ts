import * as SecureStore from "expo-secure-store";

const CREDS_KEY = "dd.basicAuth";

export interface BasicCreds {
    username: string;
    password: string;
}

export async function saveBasicCreds(creds: BasicCreds): Promise<void> {
    await SecureStore.setItemAsync(CREDS_KEY, JSON.stringify(creds));
}

export async function loadBasicCreds(): Promise<BasicCreds | null> {
    const raw = await SecureStore.getItemAsync(CREDS_KEY);

    if (!raw) {
        return null;
    }

    return JSON.parse(raw) as BasicCreds;
}

export async function clearBasicCreds(): Promise<void> {
    await SecureStore.deleteItemAsync(CREDS_KEY);
}

/**
 * `btoa` is Latin-1 only under Hermes and throws on any character above U+00FF, so the string is
 * encoded to UTF-8 bytes first and those bytes are what get base64'd.
 */
function base64Utf8(value: string): string {
    let binary = "";

    for (const byte of new TextEncoder().encode(value)) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}

/**
 * Build the `Authorization: Basic …` header value from stored creds, or null when
 * none are present. Used by the connection store + contract client.
 */
export async function loadBasicAuthHeader(): Promise<string | null> {
    const creds = await loadBasicCreds();

    if (!creds) {
        return null;
    }

    return `Basic ${base64Utf8(`${creds.username}:${creds.password}`)}`;
}

// E2E keypairs (plan 02 managed tier) also live here under separate keys — never in
// KV/SQLite. They are added by plan 02; the secure store is the only sanctioned home
// for secrets (Keychain on iOS / Keystore on Android).
