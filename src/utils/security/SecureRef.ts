/**
 * A pointer to a secret held in the vault. Configs store these instead of
 * plaintext credentials, so `cat`ting a config never reveals a token.
 */
export interface SecureRef {
    readonly type: "secure";
    readonly path: string;
}

/** A credential field that may be a literal value or a vault pointer. */
export type MaybeSecret = string | SecureRef;

/**
 * Logical vault addresses: `<domain>/<segment>[/<segment>...]`, e.g.
 * `ai/acc_xai_key/apiKey`. Never a filesystem path -- the leading segment is a
 * namespace, and `.` segments are allowed only inside a name (`secondary.accessToken`).
 */
const SECRET_PATH_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export function isSecureRef(value: unknown): value is SecureRef {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as { type?: unknown; path?: unknown };
    if (candidate.type !== "secure" || typeof candidate.path !== "string") {
        return false;
    }

    return SECRET_PATH_PATTERN.test(candidate.path);
}

export function isSecretPath(path: string): boolean {
    return SECRET_PATH_PATTERN.test(path);
}

/** Build a validated SecureRef. Throws on a malformed path so bad writes fail loudly. */
export function secureRef(path: string): SecureRef {
    if (!isSecretPath(path)) {
        throw new Error(
            `Invalid secret path "${path}". Expected <domain>/<name>[/<name>...] using [A-Za-z0-9._-], e.g. "ai/acc_xai_key/apiKey".`
        );
    }

    return { type: "secure", path };
}
