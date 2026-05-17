/**
 * Display title for a Claude account: "<accountName> · <label>", or just the
 * account name when the label is absent or the placeholder "none". Shared by
 * AccountCard and AccountUsageChart so the two never drift.
 */
export function formatAccountTitle(accountName?: string, label?: string): string {
    const name = accountName?.trim() || "Unknown account";
    const trimmed = label?.trim();

    return trimmed && trimmed.toLowerCase() !== "none" ? `${name} · ${trimmed}` : name;
}
