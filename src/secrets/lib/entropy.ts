/**
 * Shannon entropy in bits per character. Used as a gate for the
 * high-entropy-base64 detector — high values indicate randomness (likely a
 * generated secret) rather than English text or repeated padding.
 */
export function shannonEntropy(value: string): number {
    if (value.length === 0) {
        return 0;
    }

    const counts = new Map<string, number>();
    for (const char of value) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    let entropy = 0;
    const length = value.length;
    for (const count of counts.values()) {
        const p = count / length;
        entropy -= p * Math.log2(p);
    }

    return entropy;
}
