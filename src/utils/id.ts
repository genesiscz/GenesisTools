const SUFFIX_LENGTH = 8;

/** A short id that sorts roughly by creation time: base-36 millisecond timestamp plus eight random characters. */
export function generateId(): string {
    const random = crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH));
    const suffix = Array.from(random, (byte) => (byte % 36).toString(36)).join("");

    return Date.now().toString(36) + suffix;
}
