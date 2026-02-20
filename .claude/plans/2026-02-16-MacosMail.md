# macOS Mail Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a CLI tool (`tools macos-mail`) that searches, lists, and downloads emails from macOS Mail.app using a hybrid SQLite + JXA approach.

**Architecture:** The tool queries Mail.app's SQLite database (`~/Library/Mail/V10/MailData/Envelope Index`) for fast metadata search (subjects, senders, attachments, dates), then optionally uses JXA (`osascript -l JavaScript`) to retrieve message body content and save attachments. Results are displayed as tables or exported as markdown files. The database is always copied to `/tmp/` before querying to avoid locking Mail.app.

**Tech Stack:** Bun runtime, `bun:sqlite` (built-in), Commander for CLI, `@clack/prompts` for UX, `osascript` for JXA execution, existing `@app/utils/table` and `@app/utils/format` utilities.

---

## File Structure

```
src/macos-mail/
  index.ts              # Commander setup, entry point
  commands/
    search.ts           # Search command (SQLite + optional JXA body search)
    list.ts             # List recent emails from a mailbox
    download.ts         # Download search results as markdown
  lib/
    types.ts            # TypeScript interfaces
    constants.ts        # DB path, mailbox URL parsing
    sqlite.ts           # SQLite database queries
    jxa.ts              # JXA script execution (body retrieval, attachment saving)
    format.ts           # Output formatting (table, markdown)
    transform.ts        # Row-to-domain-object conversion (shared by commands)
```

---

### Task 1: Types & Constants

**Files:**
- Create: `src/macos-mail/lib/types.ts`
- Create: `src/macos-mail/lib/constants.ts`

**Step 1: Create types**

Create `src/macos-mail/lib/types.ts`:

```typescript
/** Raw row from the SQLite join query */
export interface MailMessageRow {
    rowid: number;
    subject: string;
    senderAddress: string;
    senderName: string;
    dateSent: number;
    dateReceived: number;
    mailboxUrl: string;
    read: number;
    flagged: number;
    deleted: number;
    size: number;
}

/** Enriched message with optional body + attachment info */
export interface MailMessage {
    rowid: number;
    subject: string;
    senderAddress: string;
    senderName: string;
    dateSent: Date;
    dateReceived: Date;
    mailbox: string;
    account: string;
    read: boolean;
    flagged: boolean;
    size: number;
    attachments: MailAttachment[];
    body?: string;
    bodyMatchesQuery?: boolean;
    recipients?: MailRecipient[];
}

export interface MailAttachment {
    name: string;
    attachmentId: string;
}

export interface MailRecipient {
    address: string;
    name: string;
    type: "to" | "cc";
}

export interface SearchOptions {
    query: string;
    withoutBody?: boolean;
    receiver?: string;
    from?: Date;
    to?: Date;
    mailbox?: string;
    limit?: number;
}

export interface ReceiverInfo {
    address: string;
    name: string;
    messageCount: number;
}
```

**Step 2: Create constants**

Create `src/macos-mail/lib/constants.ts`:

```typescript
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
 *   "ews://B4F641BE-.../Do%C5%99u%C4%8Den%C3%A1%20po%C5%A1ta" -> { account: "B4F641BE-...", mailbox: "Doručená pošta" }
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
```

**Step 3: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors from macos-mail files.

**Step 4: Commit**
```bash
git add src/macos-mail/lib/types.ts src/macos-mail/lib/constants.ts
git commit -m "feat(macos-mail): add types and constants"
```

---

### Task 2: SQLite Database Layer

**Files:**
- Create: `src/macos-mail/lib/sqlite.ts`

**Step 1: Write the SQLite module**

Create `src/macos-mail/lib/sqlite.ts`:

```typescript
import { Database } from "bun:sqlite";
import { existsSync, copyFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import logger from "@app/logger";
import { ENVELOPE_INDEX_PATH, TEMP_DB_PREFIX } from "./constants.ts";
import type {
    MailMessageRow,
    MailAttachment,
    MailRecipient,
    ReceiverInfo,
    SearchOptions,
} from "./types.ts";

let _tempDbPath: string | null = null;
let _db: Database | null = null;

/**
 * Copy the Envelope Index to a temp file and open it.
 * Reuses the same copy within a single CLI invocation.
 */
export function getDatabase(): Database {
    if (_db) return _db;

    if (!existsSync(ENVELOPE_INDEX_PATH)) {
        throw new Error(
            `Mail database not found at: ${ENVELOPE_INDEX_PATH}\n` +
            "Make sure Mail.app is configured and has downloaded messages."
        );
    }

    _tempDbPath = join(tmpdir(), `${TEMP_DB_PREFIX}-${Date.now()}.sqlite`);
    logger.debug(`Copying Mail database to ${_tempDbPath}`);
    copyFileSync(ENVELOPE_INDEX_PATH, _tempDbPath);

    // Also copy WAL and SHM if they exist (for consistency)
    const walPath = ENVELOPE_INDEX_PATH + "-wal";
    const shmPath = ENVELOPE_INDEX_PATH + "-shm";
    if (existsSync(walPath)) copyFileSync(walPath, _tempDbPath + "-wal");
    if (existsSync(shmPath)) copyFileSync(shmPath, _tempDbPath + "-shm");

    _db = new Database(_tempDbPath, { readonly: true });
    return _db;
}

/** Clean up the temp database file */
export function cleanup(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
    if (_tempDbPath) {
        try { unlinkSync(_tempDbPath); } catch {}
        try { unlinkSync(_tempDbPath + "-wal"); } catch {}
        try { unlinkSync(_tempDbPath + "-shm"); } catch {}
        _tempDbPath = null;
    }
}

/**
 * Search messages by metadata (subject, sender, attachment names).
 * Does NOT search body content -- that requires JXA.
 *
 * The query uses OR to combine:
 * 1. Subject LIKE match
 * 2. Sender address/name LIKE match
 * 3. Attachment name LIKE match
 */
export function searchMessages(opts: SearchOptions): MailMessageRow[] {
    const db = getDatabase();
    const params: Record<string, string | number> = {};
    const queryPattern = `%${opts.query}%`;
    params.$query = queryPattern;

    // Build WHERE clauses for filters
    const filters: string[] = ["m.deleted = 0"];

    if (opts.from) {
        filters.push("m.date_sent >= $dateFrom");
        params.$dateFrom = Math.floor(opts.from.getTime() / 1000);
    }
    if (opts.to) {
        filters.push("m.date_sent <= $dateTo");
        params.$dateTo = Math.floor(opts.to.getTime() / 1000);
    }
    if (opts.mailbox) {
        filters.push("mb.url LIKE $mailbox");
        params.$mailbox = `%${opts.mailbox}%`;
    }
    if (opts.receiver) {
        filters.push(`m.ROWID IN (
            SELECT r.message FROM recipients r
            JOIN addresses a ON r.address = a.ROWID
            WHERE a.address LIKE $receiver
        )`);
        params.$receiver = `%${opts.receiver}%`;
    }

    const whereClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;

    const sql = `
        SELECT DISTINCT
            m.ROWID as rowid,
            s.subject,
            a.address as senderAddress,
            a.comment as senderName,
            m.date_sent as dateSent,
            m.date_received as dateReceived,
            mb.url as mailboxUrl,
            m.read,
            m.flagged,
            m.deleted,
            m.size
        FROM messages m
        JOIN subjects s ON m.subject = s.ROWID
        JOIN addresses a ON m.sender = a.ROWID
        JOIN mailboxes mb ON m.mailbox = mb.ROWID
        WHERE (
            s.subject LIKE $query
            OR a.address LIKE $query
            OR a.comment LIKE $query
            OR m.ROWID IN (
                SELECT att.message FROM attachments att
                WHERE att.name LIKE $query
            )
        )
        ${whereClause}
        ORDER BY m.date_sent DESC
        LIMIT ${limit}
    `;

    logger.debug(`Running search query with pattern: ${queryPattern}`);
    const stmt = db.prepare(sql);
    return stmt.all(params) as MailMessageRow[];
}

/**
 * List recent messages from a mailbox.
 */
export function listMessages(mailbox: string, limit: number): MailMessageRow[] {
    const db = getDatabase();
    const mailboxPattern = `%${mailbox}%`;

    const sql = `
        SELECT
            m.ROWID as rowid,
            s.subject,
            a.address as senderAddress,
            a.comment as senderName,
            m.date_sent as dateSent,
            m.date_received as dateReceived,
            mb.url as mailboxUrl,
            m.read,
            m.flagged,
            m.deleted,
            m.size
        FROM messages m
        JOIN subjects s ON m.subject = s.ROWID
        JOIN addresses a ON m.sender = a.ROWID
        JOIN mailboxes mb ON m.mailbox = mb.ROWID
        WHERE m.deleted = 0
          AND mb.url LIKE $mailbox
        ORDER BY m.date_sent DESC
        LIMIT $limit
    `;

    return db.prepare(sql).all({ $mailbox: mailboxPattern, $limit: limit }) as MailMessageRow[];
}

/**
 * Get attachments for a set of message ROWIDs.
 */
export function getAttachments(messageRowids: number[]): Map<number, MailAttachment[]> {
    if (messageRowids.length === 0) return new Map();
    const db = getDatabase();

    const placeholders = messageRowids.map(() => "?").join(",");
    const sql = `
        SELECT message, name, attachment_id as attachmentId
        FROM attachments
        WHERE message IN (${placeholders})
        ORDER BY message, ROWID
    `;

    const rows = db.prepare(sql).all(...messageRowids) as Array<{
        message: number;
        name: string;
        attachmentId: string;
    }>;

    const map = new Map<number, MailAttachment[]>();
    for (const row of rows) {
        const list = map.get(row.message) ?? [];
        list.push({ name: row.name, attachmentId: row.attachmentId });
        map.set(row.message, list);
    }
    return map;
}

/**
 * Get recipients (To/CC) for a set of message ROWIDs.
 */
export function getRecipients(messageRowids: number[]): Map<number, MailRecipient[]> {
    if (messageRowids.length === 0) return new Map();
    const db = getDatabase();

    const placeholders = messageRowids.map(() => "?").join(",");
    const sql = `
        SELECT r.message, a.address, a.comment as name, r.type
        FROM recipients r
        JOIN addresses a ON r.address = a.ROWID
        WHERE r.message IN (${placeholders})
        ORDER BY r.message, r.type, r.position
    `;

    const rows = db.prepare(sql).all(...messageRowids) as Array<{
        message: number;
        address: string;
        name: string;
        type: number;
    }>;

    const map = new Map<number, MailRecipient[]>();
    for (const row of rows) {
        const list = map.get(row.message) ?? [];
        list.push({
            address: row.address,
            name: row.name,
            type: row.type === 0 ? "to" : "cc",
        });
        map.set(row.message, list);
    }
    return map;
}

/**
 * List all receiver addresses with message counts.
 * Used by --help-receivers flag.
 */
export function listReceivers(): ReceiverInfo[] {
    const db = getDatabase();
    const sql = `
        SELECT
            a.address,
            a.comment as name,
            COUNT(DISTINCT r.message) as messageCount
        FROM recipients r
        JOIN addresses a ON r.address = a.ROWID
        WHERE r.type = 0
        GROUP BY a.address, a.comment
        HAVING messageCount > 10
        ORDER BY messageCount DESC
        LIMIT 50
    `;
    return db.prepare(sql).all() as ReceiverInfo[];
}

/**
 * List all mailboxes with message counts.
 */
export function listMailboxes(): Array<{ url: string; totalCount: number; unreadCount: number }> {
    const db = getDatabase();
    const sql = `
        SELECT url, total_count as totalCount, unread_count as unreadCount
        FROM mailboxes
        WHERE total_count > 0
        ORDER BY total_count DESC
    `;
    return db.prepare(sql).all() as Array<{ url: string; totalCount: number; unreadCount: number }>;
}

/**
 * Get total message count (for progress reporting).
 */
export function getMessageCount(): number {
    const db = getDatabase();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE deleted = 0").get() as { cnt: number };
    return row.cnt;
}
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors from macos-mail files.

**Step 3: Commit**
```bash
git add src/macos-mail/lib/sqlite.ts
git commit -m "feat(macos-mail): add SQLite database layer"
```

---

### Task 3: JXA Execution Layer

**Files:**
- Create: `src/macos-mail/lib/jxa.ts`

**Step 1: Write the JXA module**

Create `src/macos-mail/lib/jxa.ts`:

```typescript
import logger from "@app/logger";

interface JxaResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Execute a JXA script via osascript and return the result.
 */
async function runJxa(script: string, timeoutMs = 30_000): Promise<JxaResult> {
    const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => {
            proc.kill();
            reject(new Error(`JXA script timed out after ${timeoutMs}ms`));
        }, timeoutMs)
    );

    const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]),
        timeoutPromise,
    ]) as [string, string, number];

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/**
 * Escape a string for embedding in a JXA double-quoted string literal.
 */
function escapeJxa(s: string): string {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r");
}

/**
 * Search message bodies for a query string.
 * Given a list of messages (identified by subject), uses JXA to:
 * 1. Find messages in Mail.app by subject
 * 2. Get body content
 * 3. Check if body contains the query
 *
 * Returns a Set of rowids that matched in the body.
 * Processes in batches of 50 to avoid JXA timeouts.
 */
export async function searchBodies(
    messageIdentifiers: Array<{ rowid: number; subject: string; mailbox: string }>,
    query: string,
): Promise<Set<number>> {
    if (messageIdentifiers.length === 0) return new Set();

    const matchedRowids = new Set<number>();
    const batchSize = 50;

    for (let i = 0; i < messageIdentifiers.length; i += batchSize) {
        const batch = messageIdentifiers.slice(i, i + batchSize);
        const subjectList = JSON.stringify(
            batch.map(m => ({ rowid: m.rowid, subject: m.subject }))
        );
        const escapedQuery = escapeJxa(query);

        const script = `
            var Mail = Application("Mail");
            var query = "${escapedQuery}".toLowerCase();
            var results = [];
            var identifiers = ${subjectList};

            for (var i = 0; i < identifiers.length; i++) {
                try {
                    var subj = identifiers[i].subject;
                    var found = false;
                    var accounts = Mail.accounts();
                    for (var a = 0; a < accounts.length && !found; a++) {
                        var mailboxes = accounts[a].mailboxes();
                        for (var b = 0; b < mailboxes.length && !found; b++) {
                            try {
                                var msgs = mailboxes[b].messages.whose({
                                    subject: { _equals: subj }
                                })();
                                for (var m = 0; m < msgs.length && !found; m++) {
                                    try {
                                        var content = msgs[m].content();
                                        if (content && content.toLowerCase().indexOf(query) !== -1) {
                                            results.push(identifiers[i].rowid);
                                            found = true;
                                        }
                                    } catch(e) {}
                                }
                            } catch(e) {}
                        }
                    }
                } catch(e) {}
            }
            JSON.stringify(results);
        `;

        try {
            const result = await runJxa(script, 60_000);
            if (result.exitCode === 0 && result.stdout) {
                const rowids = JSON.parse(result.stdout) as number[];
                for (const r of rowids) matchedRowids.add(r);
            }
        } catch (err) {
            logger.warn(`JXA body search batch failed: ${err}`);
        }
    }

    return matchedRowids;
}

/**
 * Get the full body content of a single message by subject + sender.
 * Returns plain text body or null if not found.
 */
export async function getMessageBody(
    subject: string,
    _dateSent: Date,
    senderAddress: string,
): Promise<string | null> {
    const escapedSubject = escapeJxa(subject);
    const escapedSender = escapeJxa(senderAddress);

    const script = `
        var Mail = Application("Mail");
        var targetSubject = "${escapedSubject}";
        var targetSender = "${escapedSender}";
        var content = null;

        var accounts = Mail.accounts();
        for (var a = 0; a < accounts.length; a++) {
            if (content !== null) break;
            var mailboxes = accounts[a].mailboxes();
            for (var b = 0; b < mailboxes.length; b++) {
                if (content !== null) break;
                try {
                    var msgs = mailboxes[b].messages.whose({
                        subject: { _equals: targetSubject },
                        sender: { _contains: targetSender }
                    })();
                    if (msgs.length > 0) {
                        try {
                            content = msgs[0].content();
                        } catch(e) {
                            content = "[Could not retrieve body]";
                        }
                    }
                } catch(e) {}
            }
        }
        JSON.stringify({ body: content });
    `;

    try {
        const result = await runJxa(script, 30_000);
        if (result.exitCode === 0 && result.stdout) {
            const parsed = JSON.parse(result.stdout) as { body: string | null };
            return parsed.body;
        }
    } catch (err) {
        logger.warn(`Failed to get message body: ${err}`);
    }
    return null;
}

/**
 * Save an attachment from a message to a local path.
 * Uses JXA to find the message and save the attachment.
 */
export async function saveAttachment(
    subject: string,
    senderAddress: string,
    attachmentName: string,
    savePath: string,
): Promise<boolean> {
    const escapedSubject = escapeJxa(subject);
    const escapedSender = escapeJxa(senderAddress);
    const escapedAttName = escapeJxa(attachmentName);
    const escapedPath = escapeJxa(savePath);

    const script = `
        var Mail = Application("Mail");
        var app = Application.currentApplication();
        app.includeStandardAdditions = true;

        var targetSubject = "${escapedSubject}";
        var targetSender = "${escapedSender}";
        var targetAttachment = "${escapedAttName}";
        var savePath = "${escapedPath}";
        var saved = false;

        var accounts = Mail.accounts();
        for (var a = 0; a < accounts.length && !saved; a++) {
            var mailboxes = accounts[a].mailboxes();
            for (var b = 0; b < mailboxes.length && !saved; b++) {
                try {
                    var msgs = mailboxes[b].messages.whose({
                        subject: { _equals: targetSubject },
                        sender: { _contains: targetSender }
                    })();
                    for (var m = 0; m < msgs.length && !saved; m++) {
                        try {
                            var atts = msgs[m].mailAttachments();
                            for (var at = 0; at < atts.length && !saved; at++) {
                                if (atts[at].name() === targetAttachment) {
                                    atts[at].save({ in: Path(savePath) });
                                    saved = true;
                                }
                            }
                        } catch(e) {}
                    }
                } catch(e) {}
            }
        }
        JSON.stringify({ saved: saved });
    `;

    try {
        const result = await runJxa(script, 30_000);
        if (result.exitCode === 0 && result.stdout) {
            const parsed = JSON.parse(result.stdout) as { saved: boolean };
            return parsed.saved;
        }
    } catch (err) {
        logger.warn(`Failed to save attachment: ${err}`);
    }
    return false;
}
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors.

**Step 3: Commit**
```bash
git add src/macos-mail/lib/jxa.ts
git commit -m "feat(macos-mail): add JXA execution layer"
```

---

### Task 4: Output Formatting

**Files:**
- Create: `src/macos-mail/lib/format.ts`

**Step 1: Write the format module**

Uses existing `@app/utils/table` for table output and `@app/utils/format` for `formatRelativeTime` and `formatBytes`.

Create `src/macos-mail/lib/format.ts`:

```typescript
import { formatTable } from "@app/utils/table.ts";
import { formatRelativeTime, formatBytes } from "@app/utils/format.ts";
import type { MailMessage } from "./types.ts";
import chalk from "chalk";

/**
 * Format search/list results as a table for terminal output.
 */
export function formatResultsTable(
    messages: MailMessage[],
    options?: { showBodyMatch?: boolean }
): string {
    const headers = ["Date", "From", "Subject", "Attachments"];
    if (options?.showBodyMatch) headers.push("Body");

    const rows = messages.map(msg => {
        const row = [
            formatRelativeTime(msg.dateSent, { compact: true }),
            formatSender(msg),
            msg.subject.slice(0, 60) + (msg.subject.length > 60 ? "..." : ""),
            msg.attachments.length > 0 ? `${msg.attachments.length}` : "",
        ];
        if (options?.showBodyMatch) {
            row.push(msg.bodyMatchesQuery ? chalk.green("yes") : "");
        }
        return row;
    });

    return formatTable(rows, headers, { maxColWidth: 60 });
}

function formatSender(msg: MailMessage): string {
    if (msg.senderName && msg.senderName !== msg.senderAddress) {
        return msg.senderName;
    }
    return msg.senderAddress;
}

/**
 * Generate markdown content for a single email.
 */
export function generateEmailMarkdown(msg: MailMessage): string {
    const lines: string[] = [];

    lines.push(`# ${msg.subject}`);
    lines.push("");
    lines.push("## Metadata");
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    lines.push(`| From | ${msg.senderName} <${msg.senderAddress}> |`);

    if (msg.recipients && msg.recipients.length > 0) {
        const toRecipients = msg.recipients
            .filter(r => r.type === "to")
            .map(r => r.name ? `${r.name} <${r.address}>` : r.address);
        const ccRecipients = msg.recipients
            .filter(r => r.type === "cc")
            .map(r => r.name ? `${r.name} <${r.address}>` : r.address);

        if (toRecipients.length > 0) {
            lines.push(`| To | ${toRecipients.join(", ")} |`);
        }
        if (ccRecipients.length > 0) {
            lines.push(`| CC | ${ccRecipients.join(", ")} |`);
        }
    }

    lines.push(`| Date | ${msg.dateSent.toISOString()} |`);
    lines.push(`| Mailbox | ${msg.mailbox} |`);
    lines.push(`| Read | ${msg.read ? "Yes" : "No"} |`);
    if (msg.flagged) lines.push(`| Flagged | Yes |`);
    lines.push(`| Size | ${formatBytes(msg.size)} |`);

    if (msg.attachments.length > 0) {
        lines.push("");
        lines.push("## Attachments");
        lines.push("");
        for (const att of msg.attachments) {
            lines.push(`- ${att.name}`);
        }
    }

    if (msg.body) {
        lines.push("");
        lines.push("## Body");
        lines.push("");
        lines.push(msg.body);
    }

    return lines.join("\n");
}

/**
 * Generate the index.md summary table for downloaded emails.
 */
export function generateIndexMarkdown(
    messages: MailMessage[],
    query?: string,
): string {
    const lines: string[] = [];

    lines.push("# Email Export");
    lines.push("");
    if (query) lines.push(`Search query: \`${query}\``);
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push(`Total: ${messages.length} emails`);
    lines.push("");
    lines.push("| # | Date | From | Subject | Attachments | File |");
    lines.push("|---|------|------|---------|-------------|------|");

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const slug = generateSlug(msg);
        const date = msg.dateSent.toISOString().slice(0, 10);
        const from = formatSender(msg).replace(/\|/g, "\\|");
        const subject = msg.subject.replace(/\|/g, "\\|").slice(0, 50);
        const attCount = msg.attachments.length > 0 ? `${msg.attachments.length}` : "";
        lines.push(`| ${i + 1} | ${date} | ${from} | ${subject} | ${attCount} | [email](emails/${slug}.md) |`);
    }

    return lines.join("\n");
}

/**
 * Generate a filename-safe slug from a message.
 * Format: YYYY-MM-DD-subject-slug-ROWID.md
 */
export function generateSlug(msg: MailMessage): string {
    const date = msg.dateSent.toISOString().slice(0, 10);
    const subjectSlug = msg.subject
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
    return `${date}-${subjectSlug}-${msg.rowid}`;
}
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors.

**Step 3: Commit**
```bash
git add src/macos-mail/lib/format.ts
git commit -m "feat(macos-mail): add output formatting"
```

---

### Task 5: Transform Layer (Shared Row-to-Domain Conversion)

**Files:**
- Create: `src/macos-mail/lib/transform.ts`

**Step 1: Write the transform module**

This extracts the `rowToMessage` conversion used by both `search.ts` and `list.ts` to avoid duplication.

Create `src/macos-mail/lib/transform.ts`:

```typescript
import { parseMailboxUrl, normalizeMailboxName } from "./constants.ts";
import type { MailMessage, MailMessageRow } from "./types.ts";

/**
 * Convert a raw SQLite row to a MailMessage domain object.
 * Parses mailbox URLs, converts Unix timestamps to Dates, and normalizes booleans.
 */
export function rowToMessage(row: MailMessageRow): MailMessage {
    const { account, mailbox } = parseMailboxUrl(row.mailboxUrl);
    return {
        rowid: row.rowid,
        subject: row.subject,
        senderAddress: row.senderAddress,
        senderName: row.senderName,
        dateSent: new Date(row.dateSent * 1000),
        dateReceived: new Date(row.dateReceived * 1000),
        mailbox: normalizeMailboxName(mailbox),
        account,
        read: row.read !== 0,
        flagged: row.flagged !== 0,
        size: row.size,
        attachments: [],
    };
}
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors.

**Step 3: Commit**
```bash
git add src/macos-mail/lib/transform.ts
git commit -m "feat(macos-mail): add row-to-message transform"
```

---

### Task 6: Search Command

**Files:**
- Create: `src/macos-mail/commands/search.ts`

**Step 1: Write the search command**

Create `src/macos-mail/commands/search.ts`:

```typescript
import * as p from "@clack/prompts";
import type { Command } from "commander";
import logger from "@app/logger";
import {
    searchMessages,
    getAttachments,
    listReceivers,
    cleanup,
    getMessageCount,
} from "../lib/sqlite.ts";
import { searchBodies } from "../lib/jxa.ts";
import { formatResultsTable } from "../lib/format.ts";
import { rowToMessage } from "../lib/transform.ts";
import type { MailMessage, SearchOptions } from "../lib/types.ts";

export function registerSearchCommand(program: Command): void {
    program
        .command("search <query>")
        .description("Search emails by subject, sender, body, and attachment names")
        .option("--without-body", "Skip body search (faster, SQLite-only)")
        .option("--receiver <email>", "Filter by receiver email address")
        .option("--help-receivers", "List all receiver accounts/addresses")
        .option("--from <date>", "Search from date (ISO format, e.g. 2026-01-01)")
        .option("--to <date>", "Search to date (ISO format)")
        .option("--mailbox <name>", "Restrict to specific mailbox (e.g. INBOX, Sent)")
        .option("--limit <n>", "Max results", "100")
        .action(async (query: string, options: {
            withoutBody?: boolean;
            receiver?: string;
            helpReceivers?: boolean;
            from?: string;
            to?: string;
            mailbox?: string;
            limit?: string;
        }) => {
            try {
                // Handle --help-receivers: list receiver addresses and exit
                if (options.helpReceivers) {
                    const receivers = listReceivers();
                    console.log("\nReceiver addresses (by message count):\n");
                    for (const r of receivers) {
                        const name = r.name ? ` (${r.name})` : "";
                        console.log(`  ${r.address}${name}  [${r.messageCount} msgs]`);
                    }
                    cleanup();
                    return;
                }

                const parseDate = (s?: string): Date | undefined => {
                    if (!s) return undefined;
                    const d = new Date(s);
                    if (Number.isNaN(d.getTime())) {
                        throw new Error(`Invalid date: ${s}`);
                    }
                    return d;
                };

                const searchOpts: SearchOptions = {
                    query,
                    withoutBody: options.withoutBody,
                    receiver: options.receiver,
                    from: parseDate(options.from),
                    to: parseDate(options.to),
                    mailbox: options.mailbox,
                    limit: Number.parseInt(options.limit ?? "100", 10),
                };

                // Phase 1: SQLite metadata search
                const spinner = p.spinner();
                const totalMessages = getMessageCount();
                spinner.start(
                    `Searching metadata across ${totalMessages.toLocaleString()} messages (SQLite)...`
                );

                const startSqlite = performance.now();
                const rows = searchMessages(searchOpts);
                const sqliteMs = performance.now() - startSqlite;

                spinner.stop(
                    `Found ${rows.length} metadata matches in ${(sqliteMs / 1000).toFixed(1)}s`
                );

                if (rows.length === 0) {
                    p.log.info("No messages found matching your query.");
                    cleanup();
                    return;
                }

                // Enrich with attachments
                const rowids = rows.map(r => r.rowid);
                const attachmentsMap = getAttachments(rowids);
                const messages: MailMessage[] = rows.map(row => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    return msg;
                });

                // Phase 2: JXA body search (unless --without-body)
                if (!searchOpts.withoutBody && rows.length > 0) {
                    spinner.start(
                        `Searching body content in ${rows.length} messages (JXA)...`
                    );

                    const startJxa = performance.now();
                    const bodyMatches = await searchBodies(
                        messages.map(m => ({
                            rowid: m.rowid,
                            subject: m.subject,
                            mailbox: m.mailbox,
                        })),
                        query,
                    );
                    const jxaMs = performance.now() - startJxa;

                    for (const msg of messages) {
                        msg.bodyMatchesQuery = bodyMatches.has(msg.rowid);
                    }

                    const bodyMatchCount = bodyMatches.size;
                    spinner.stop(
                        `Body search complete: ${bodyMatchCount} body matches in ${(jxaMs / 1000).toFixed(1)}s`
                    );
                }

                // Output results table
                console.log("");
                console.log(formatResultsTable(messages, {
                    showBodyMatch: !searchOpts.withoutBody,
                }));
                console.log("");
                p.log.info(`${messages.length} results. Use 'tools macos-mail download <dir>' to export.`);

                // Save results to temp file for download command
                const tempResults = JSON.stringify(
                    messages.map(m => ({
                        ...m,
                        dateSent: m.dateSent.toISOString(),
                        dateReceived: m.dateReceived.toISOString(),
                    }))
                );
                await Bun.write("/tmp/macos-mail-last-search.json", tempResults);
                logger.debug("Saved search results to /tmp/macos-mail-last-search.json");

            } catch (error) {
                p.log.error(
                    error instanceof Error ? error.message : String(error)
                );
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors.

**Step 3: Manual test**

```bash
bun run src/macos-mail/index.ts search "invoice" --without-body --limit 5
```
Expected: Table of matching emails (or "No messages found" if no matches). Should complete in < 5s.

**Step 4: Commit**
```bash
git add src/macos-mail/commands/search.ts
git commit -m "feat(macos-mail): add search command"
```

---

### Task 7: List Command

**Files:**
- Create: `src/macos-mail/commands/list.ts`

**Step 1: Write the list command**

Create `src/macos-mail/commands/list.ts`:

```typescript
import * as p from "@clack/prompts";
import type { Command } from "commander";
import {
    listMessages,
    getAttachments,
    cleanup,
} from "../lib/sqlite.ts";
import { formatResultsTable } from "../lib/format.ts";
import { rowToMessage } from "../lib/transform.ts";
import type { MailMessage } from "../lib/types.ts";

export function registerListCommand(program: Command): void {
    program
        .command("list [mailbox]")
        .description("List recent emails from a mailbox (default: INBOX)")
        .option("--limit <n>", "Number of emails to show", "20")
        .action(async (mailbox: string | undefined, options: { limit?: string }) => {
            try {
                const targetMailbox = mailbox ?? "INBOX";
                const limit = Number.parseInt(options.limit ?? "20", 10);

                const spinner = p.spinner();
                spinner.start(`Fetching latest ${limit} emails from ${targetMailbox}...`);

                const rows = listMessages(targetMailbox, limit);

                if (rows.length === 0) {
                    spinner.stop(`No messages found in ${targetMailbox}.`);
                    cleanup();
                    return;
                }

                // Enrich with attachments
                const rowids = rows.map(r => r.rowid);
                const attachmentsMap = getAttachments(rowids);
                const messages: MailMessage[] = rows.map(row => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    return msg;
                });

                spinner.stop(`${messages.length} emails from ${targetMailbox}`);

                console.log("");
                console.log(formatResultsTable(messages));

            } catch (error) {
                p.log.error(
                    error instanceof Error ? error.message : String(error)
                );
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors.

**Step 3: Manual test**

```bash
bun run src/macos-mail/index.ts list INBOX --limit 5
```
Expected: Table of 5 most recent INBOX emails.

**Step 4: Commit**
```bash
git add src/macos-mail/commands/list.ts
git commit -m "feat(macos-mail): add list command"
```

---

### Task 8: Download Command

**Files:**
- Create: `src/macos-mail/commands/download.ts`

**Step 1: Write the download command**

Create `src/macos-mail/commands/download.ts`:

```typescript
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import logger from "@app/logger";
import { getRecipients, cleanup } from "../lib/sqlite.ts";
import { getMessageBody, saveAttachment } from "../lib/jxa.ts";
import {
    generateEmailMarkdown,
    generateIndexMarkdown,
    generateSlug,
} from "../lib/format.ts";
import type { MailMessage } from "../lib/types.ts";

/** Load the last search results from temp file */
function loadLastSearchResults(): MailMessage[] | null {
    const path = "/tmp/macos-mail-last-search.json";
    if (!existsSync(path)) return null;

    try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
        return parsed.map(m => ({
            ...m,
            dateSent: new Date(m.dateSent as string),
            dateReceived: new Date(m.dateReceived as string),
        })) as MailMessage[];
    } catch {
        return null;
    }
}

export function registerDownloadCommand(program: Command): void {
    program
        .command("download <output-dir>")
        .description("Download search results as markdown files")
        .option("--yes", "Skip all confirmations")
        .option("--overwrite", "Overwrite existing index.md")
        .option("--append", "Append to existing index.md")
        .option("--save-attachments", "Download attachments to output-dir/attachments/")
        .action(async (outputDirArg: string, options: {
            yes?: boolean;
            overwrite?: boolean;
            append?: boolean;
            saveAttachments?: boolean;
        }) => {
            try {
                const outputDir = resolve(outputDirArg);
                const isTTY = process.stdout.isTTY;

                // Load last search results
                const messages = loadLastSearchResults();
                if (!messages || messages.length === 0) {
                    p.log.error(
                        "No search results found. Run 'tools macos-mail search <query>' first."
                    );
                    process.exit(1);
                }

                p.log.info(`Downloading ${messages.length} emails to ${outputDir}`);

                // Check for existing index.md
                const indexPath = join(outputDir, "index.md");
                if (existsSync(indexPath) && !options.overwrite && !options.append) {
                    if (!isTTY && !options.yes) {
                        p.log.error(
                            `${indexPath} already exists. Use --overwrite, --append, or --yes.`
                        );
                        process.exit(1);
                    }

                    if (isTTY && !options.yes) {
                        const action = await p.select({
                            message: `${indexPath} already exists. What to do?`,
                            options: [
                                { value: "overwrite", label: "Overwrite" },
                                { value: "append", label: "Append" },
                                { value: "skip", label: "Cancel" },
                            ],
                        });

                        if (p.isCancel(action) || action === "skip") {
                            p.cancel("Download cancelled.");
                            process.exit(0);
                        }

                        if (action === "overwrite") options.overwrite = true;
                        if (action === "append") options.append = true;
                    }
                }

                // Warn on large result sets
                if (messages.length > 100 && !options.yes) {
                    if (!isTTY) {
                        p.log.error(
                            `${messages.length} messages to download. Use --yes to confirm.`
                        );
                        process.exit(1);
                    }

                    const proceed = await p.confirm({
                        message: `Download ${messages.length} emails? This may take a while.`,
                    });
                    if (p.isCancel(proceed) || !proceed) {
                        p.cancel("Download cancelled.");
                        process.exit(0);
                    }
                }

                // Create directories
                const emailsDir = join(outputDir, "emails");
                mkdirSync(emailsDir, { recursive: true });

                if (options.saveAttachments) {
                    mkdirSync(join(outputDir, "attachments"), { recursive: true });
                }

                // Fetch recipients for all messages
                const rowids = messages.map(m => m.rowid);
                const recipientsMap = getRecipients(rowids);

                // Process each email
                const spinner = p.spinner();
                let processed = 0;

                for (const msg of messages) {
                    processed++;
                    spinner.start(
                        `[${processed}/${messages.length}] ${msg.subject.slice(0, 50)}...`
                    );

                    // Attach recipients
                    msg.recipients = recipientsMap.get(msg.rowid) ?? [];

                    // Get body via JXA
                    const body = await getMessageBody(
                        msg.subject,
                        msg.dateSent,
                        msg.senderAddress,
                    );
                    msg.body = body ?? undefined;

                    // Generate markdown
                    const slug = generateSlug(msg);
                    const emailMd = generateEmailMarkdown(msg);
                    writeFileSync(join(emailsDir, `${slug}.md`), emailMd);

                    // Save attachments if requested
                    if (options.saveAttachments && msg.attachments.length > 0) {
                        for (const att of msg.attachments) {
                            const attPath = join(outputDir, "attachments", att.name);
                            if (!existsSync(attPath)) {
                                await saveAttachment(
                                    msg.subject,
                                    msg.senderAddress,
                                    att.name,
                                    attPath,
                                );
                            }
                        }
                    }
                }
                spinner.stop(`Processed ${processed} emails`);

                // Generate index.md
                const indexMd = generateIndexMarkdown(messages);
                if (options.append && existsSync(indexPath)) {
                    const existing = readFileSync(indexPath, "utf-8");
                    writeFileSync(indexPath, existing + "\n\n---\n\n" + indexMd);
                } else {
                    writeFileSync(indexPath, indexMd);
                }

                p.log.success(`Downloaded to ${outputDir}`);
                p.log.info(`  Index: ${indexPath}`);
                p.log.info(`  Emails: ${emailsDir}/ (${messages.length} files)`);
                if (options.saveAttachments) {
                    p.log.info(`  Attachments: ${join(outputDir, "attachments")}/`);
                }

            } catch (error) {
                p.log.error(
                    error instanceof Error ? error.message : String(error)
                );
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors.

**Step 3: Manual test**

```bash
# First run a search to populate /tmp/macos-mail-last-search.json
bun run src/macos-mail/index.ts search "test" --without-body --limit 3
# Then download
bun run src/macos-mail/index.ts download /tmp/mail-export --yes
ls /tmp/mail-export/
cat /tmp/mail-export/index.md
```
Expected: `index.md` and `emails/` directory with 3 markdown files.

**Step 4: Commit**
```bash
git add src/macos-mail/commands/download.ts
git commit -m "feat(macos-mail): add download command"
```

---

### Task 9: Entry Point & Command Registration

**Files:**
- Create: `src/macos-mail/index.ts`

**Step 1: Write the entry point**

Follows the exact pattern from `src/azure-devops/index.ts`:
- Shebang for Bun
- `handleReadmeFlag` early
- Commander program with `showHelpAfterError`
- `registerXxxCommand(program)` pattern
- `parseAsync` for async command handlers

Create `src/macos-mail/index.ts`:

```typescript
#!/usr/bin/env bun

/**
 * macOS Mail CLI Tool
 *
 * Search, list, and download emails from Mail.app.
 * Uses a hybrid SQLite + JXA approach for performance.
 *
 * Usage:
 *   tools macos-mail search <query> [options]
 *   tools macos-mail list [mailbox] [options]
 *   tools macos-mail download <output-dir> [options]
 */

import { handleReadmeFlag } from "@app/utils/readme.ts";
import logger from "@app/logger.ts";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

import { registerSearchCommand } from "./commands/search.ts";
import { registerListCommand } from "./commands/list.ts";
import { registerDownloadCommand } from "./commands/download.ts";

const program = new Command();

program
    .name("macos-mail")
    .description("Search, list, and download emails from macOS Mail.app")
    .version("1.0.0")
    .showHelpAfterError(true);

// Register all commands
registerSearchCommand(program);
registerListCommand(program);
registerDownloadCommand(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);

        // Check for common permission errors
        if (message.includes("not authorized") || message.includes("permission")) {
            console.log("\nTo fix permission issues:");
            console.log("  1. Open System Settings > Privacy & Security > Full Disk Access");
            console.log("  2. Enable access for your terminal app");
            console.log("  3. Restart the terminal and try again");
        }

        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
```

**Step 2: Verify it compiles**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No errors from any macos-mail files.

**Step 3: Test help output**

```bash
bun run src/macos-mail/index.ts --help
```
Expected output:
```
Usage: macos-mail [options] [command]

Search, list, and download emails from macOS Mail.app

Options:
  -V, --version      output the version number
  -h, --help         display help for command

Commands:
  search <query>     Search emails by subject, sender, body, and attachment names
  list [mailbox]     List recent emails from a mailbox (default: INBOX)
  download <output-dir>  Download search results as markdown files
  help [command]     display help for a command
```

**Step 4: Test via tools command**

```bash
tools macos-mail --help
tools macos-mail search --help
```
Expected: Same help output via the `tools` launcher.

**Step 5: Commit**
```bash
git add src/macos-mail/index.ts
git commit -m "feat(macos-mail): add entry point and command registration"
```

---

### Task 10: End-to-End Testing

No new files to create. This task verifies the full workflow.

**Step 1: Test list command**

```bash
tools macos-mail list
tools macos-mail list INBOX --limit 5
```
Expected: Table of recent emails. Should complete in < 3s.

**Step 2: Test search (metadata only)**

```bash
tools macos-mail search "invoice" --without-body --limit 10
tools macos-mail search "github" --without-body --from 2026-01-01
```
Expected: Table of matching emails. Should complete in < 5s.

**Step 3: Test search with body**

```bash
tools macos-mail search "quarterly report" --limit 5
```
Expected: Table with "Body" column showing "yes" for body matches. May take 10-30s for JXA phase.

**Step 4: Test receiver helpers**

```bash
tools macos-mail search dummy --help-receivers
```
Expected: List of receiver addresses with message counts.

**Step 5: Test download workflow**

```bash
tools macos-mail search "test" --without-body --limit 3
tools macos-mail download /tmp/mail-export --yes
ls /tmp/mail-export/
cat /tmp/mail-export/index.md
ls /tmp/mail-export/emails/
```
Expected: `index.md` with summary table, `emails/` with 3 markdown files.

**Step 6: Test overwrite handling**

```bash
# Should prompt for overwrite/append/cancel (interactive)
tools macos-mail download /tmp/mail-export
# Force overwrite
tools macos-mail download /tmp/mail-export --overwrite
```

**Step 7: Test download with attachments**

```bash
tools macos-mail search "attachment" --without-body --limit 3
tools macos-mail download /tmp/mail-export-att --save-attachments --yes
ls /tmp/mail-export-att/attachments/
```

**Step 8: Typecheck entire tool**

```bash
tsgo --noEmit 2>&1 | rg "macos-mail"
```
Expected: No TypeScript errors.

---

## Dependencies

**No new dependencies needed.** Everything is already available:

| Dependency | Use | Source |
|------------|-----|--------|
| `bun:sqlite` | SQLite queries | Built-in (Bun runtime) |
| `commander` | CLI argument parsing | `package.json` |
| `@clack/prompts` | Interactive UX | `package.json` |
| `chalk` | Terminal colors | `package.json` |
| `@app/utils/table` | Table formatting | `src/utils/table.ts` |
| `@app/utils/format` | `formatRelativeTime`, `formatBytes` | `src/utils/format.ts` |
| `osascript` | JXA execution | Built-in macOS binary |

## Database Schema Reference

Key tables in `~/Library/Mail/V10/MailData/Envelope Index`:

```
messages (ROWID, message_id, sender -> addresses.ROWID, subject -> subjects.ROWID,
          date_sent [Unix epoch seconds], date_received, mailbox -> mailboxes.ROWID,
          read, flagged, deleted, size)

subjects (ROWID, subject TEXT)

addresses (ROWID, address TEXT, comment TEXT)
  -- comment = display name, address = email

attachments (ROWID, message -> messages.ROWID, attachment_id, name TEXT)

mailboxes (ROWID, url TEXT, total_count, unread_count)
  -- url: "imap://UUID/INBOX" or "ews://UUID/FolderName"

recipients (ROWID, message -> messages.ROWID, address -> addresses.ROWID,
            type INTEGER, position INTEGER)
  -- type 0 = To, type 1 = CC
```

## Future Enhancements (Out of Scope)

- Spotlight body search via `mdfind` as faster alternative to JXA
- MCP server mode for Claude Desktop integration
- Email statistics/analytics
- Interactive email selection after search
