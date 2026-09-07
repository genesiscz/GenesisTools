/**
 * One PKCE generator for every OAuth client in this repo.
 *
 * `ClaudeOAuthClient` and `CodexOAuthClient` each carried a private copy, which
 * is two places for the same crypto to drift. The byte lengths stay per client
 * because they are part of what each authorization server already accepted:
 * Anthropic's verifier is 32 random bytes, OpenAI's is 43.
 */
export interface PkcePair {
    verifier: string;
    /** S256 of the verifier, base64url. */
    challenge: string;
    state: string;
}

export function base64UrlEncode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/** `byteLength` random bytes, base64url encoded (so the string is longer than `byteLength`). */
export function randomBase64Url(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

export async function sha256Base64Url(input: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return base64UrlEncode(new Uint8Array(hash));
}

export async function generatePkcePair(opts: { verifierBytes?: number; stateBytes?: number } = {}): Promise<PkcePair> {
    const verifier = randomBase64Url(opts.verifierBytes ?? 32);
    const challenge = await sha256Base64Url(verifier);
    const state = randomBase64Url(opts.stateBytes ?? 32);

    return { verifier, challenge, state };
}
