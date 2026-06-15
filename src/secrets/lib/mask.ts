/**
 * Mask a secret for display: keep the first 4 and last 4 characters joined by
 * an ellipsis. Secrets of 8 chars or fewer are fully masked so we never reveal
 * half of a short secret.
 */
export function maskSecret(secret: string): string {
    if (secret.length <= 8) {
        return "••••";
    }

    return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
