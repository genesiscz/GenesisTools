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
 * Build the `Authorization: Basic …` header value from stored creds, or null when
 * none are present. base64 is encoded via the global `btoa` (provided by the RN
 * runtime). Used by the connection store + contract client.
 */
export async function loadBasicAuthHeader(): Promise<string | null> {
    const creds = await loadBasicCreds();

    if (!creds) {
        return null;
    }

    return `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
}

// E2E keypairs (plan 02 managed tier) also live here under separate keys — never in
// KV/SQLite. They are added by plan 02; the secure store is the only sanctioned home
// for secrets (Keychain on iOS / Keystore on Android).
