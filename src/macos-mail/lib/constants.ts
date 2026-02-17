import { homedir } from "os";
import { join } from "path";

/** Path to the Mail.app Envelope Index SQLite database */
export const ENVELOPE_INDEX_PATH = join(
    homedir(),
    "Library/Mail/V10/MailData/Envelope Index"
);

/** Temp directory prefix for copied database */
export const TEMP_DB_PREFIX = "MailEnvelopeIndex";

/**
 * Parse a mailbox URL into account identifier and mailbox name.
 * Examples:
 *   "imap://489C8E7D-41FA-.../INBOX" -> { account: "489C8E7D-...", mailbox: "INBOX" }
 *   "ews://B4F641BE-.../Do%C5%99u%C4%8Den%C3%A1%20po%C5%A1ta" -> { account: "B4F641BE-...", mailbox: "Dorucena posta" }
 */
export function parseMailboxUrl(url: string): { account: string; mailbox: string } {
    try {
        const decoded = decodeURIComponent(url);
        const match = decoded.match(/^(?:imap|ews):\/\/([^/]+)\/(.+)$/);
        if (match) {
            return { account: match[1], mailbox: match[2] };
        }
    } catch {
        // Fall through
    }
    return { account: "unknown", mailbox: url };
}

/**
 * Get a human-readable mailbox name, normalizing common patterns.
 * "[Gmail]/All Mail" -> "All Mail"
 * "INBOX" -> "Inbox"
 */
export function normalizeMailboxName(rawName: string): string {
    let name = rawName.replace(/^\[Gmail\]\//, "");
    if (name.toUpperCase() === "INBOX") return "Inbox";
    return name;
}
