/**
 * The original URL behind a route page's fragment, in its serialized (percent-encoded) form. The
 * bypass rule's regex is matched against the encoded request URL and the host validates
 * `URL.href`, so a decoded `a b` would never match the real `a%20b` request and "continue" would
 * land back on the route page.
 */
export function targetFromHash(hash: string): string {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    let decoded = raw;

    try {
        decoded = decodeURI(raw);
    } catch (error) {
        console.warn("[genesis-tools] undecodable route fragment; using it as is", error);
    }

    return URL.canParse(decoded) ? new URL(decoded).href : raw;
}
