# Apple Mail Body Extraction — Research Report

> Researched on 2026-03-20 | Scope: local filesystem, SQLite, GitHub, npm ecosystem

## Summary

The current JXA/osascript approach is 125–250x slower than necessary. Direct `.emlx` file reading achieves **~207 messages/sec** (50 msgs in 0.24 s) vs 30–60 s for 50 msgs via JXA. For metadata-only with pre-cached body text, the SQLite `summaries` table is even faster at **~63,000 rows/sec** — but only covers 20% of messages. The cleanest full-coverage approach is direct `.emlx` / `.partial.emlx` parsing using Node's built-in `email` module or the `mailparser` npm package, reading files from `~/Library/Mail/V10/`. **Mail.app does not need to be running.**

---

## Approach 1 — Direct `.emlx` File Reading (RECOMMENDED)

### How it works

Apple Mail stores each message as a file:

```
~/Library/Mail/V10/{accountUUID}/{MailboxName}.mbox/{innerUUID}/Data/{d1}/{d2}/{d3}/Messages/{ROWID}.emlx
```

- **`{accountUUID}`** — matches the UUID segment in the mailbox URL from the SQLite database (`ews://UUID/…` or `imap://UUID/…`)
- **`{innerUUID}`** — always `42775BE5-A266-42B3-88A5-6917D019121A` on this machine (appears constant within one Mail installation)
- **`{d1}/{d2}/{d3}`** — the first 3 digits of the ROWID, reversed: ROWID `543852` → `3/4/5`
- **`{ROWID}`** — the SQLite `messages.ROWID`, used as the filename

**File format** (3 sections):
1. First line: byte count as ASCII integer (how many bytes the MIME section occupies)
2. MIME content (RFC 2822 format — headers + body)
3. Apple XML plist with metadata (`conversation-id`, `flags`, `date-received`, etc.)

**`.partial.emlx` vs `.emlx`**: The `.partial.emlx` suffix means binary attachments (images, PDFs) have NOT been downloaded — but the **text body IS present** in both cases. 172,247 partial vs 42,689 full emlx files on this machine.

### Parsing in Python

```python
import email

def parse_emlx(path: str) -> str:
    with open(path, 'rb') as fh:
        first_line = fh.readline()
        try:
            byte_count = int(first_line.strip())
            content = fh.read(byte_count)
        except ValueError:
            content = first_line + fh.read()  # fallback if no byte count

    msg = email.message_from_bytes(content)
    for part in msg.walk():
        if part.get_content_type() == 'text/plain':
            body = part.get_payload(decode=True)
            if body:
                charset = part.get_content_charset() or 'utf-8'
                return body.decode(charset, errors='replace')
    return ''
```

### Parsing in TypeScript/Bun (mailparser)

```typescript
import { simpleParser } from "mailparser";
import { readFileSync } from "fs";

async function parseEmlx(filePath: string): Promise<string | null> {
    const content = readFileSync(filePath);
    const newlineIdx = content.indexOf(10); // '\n'
    let byteCount: number | null = null;
    try { byteCount = parseInt(content.slice(0, newlineIdx).toString().trim()); } catch {}
    const mimeContent = byteCount
        ? content.slice(newlineIdx + 1, newlineIdx + 1 + byteCount)
        : content.slice(newlineIdx + 1);
    const parsed = await simpleParser(mimeContent);
    return parsed.text ?? null;
}
```

### Finding the emlx path from SQLite ROWID

**Path construction formula:**

```typescript
import { unquote } from "querystring"; // or URLSearchParams

const INNER_UUID = "42775BE5-A266-42B3-88A5-6917D019121A";
const BASE_DIR = `${process.env.HOME}/Library/Mail/V10`;

function buildEmlxPath(rowid: number, mailboxUrl: string): string {
    // mailboxUrl examples:
    //   ews://B832C671-D561-4044-BA03-30A4A9B9BEB9/Inbox
    //   imap://489C8E7D-41FA-42D3-BA3C-AFCCAA35C146/%5BGmail%5D/Vs%CC%8Cechny%20zpra%CC%81vy
    //   local://9FC49A6D-D21D-4BF1-9C8F-C34A086CC232/Outbox

    const pathPart = mailboxUrl.split("://")[1]; // "UUID/mailbox-name"
    const slashIdx = pathPart.indexOf("/");
    const accountUUID = pathPart.slice(0, slashIdx);
    const mailboxPath = decodeURIComponent(pathPart.slice(slashIdx + 1));
    // Nested paths like "[Gmail]/Inbox" map to "[Gmail].mbox/Inbox.mbox"

    const s = String(rowid);
    const [d1, d2, d3] = [s[2] ?? "0", s[1] ?? "0", s[0]]; // reversed first 3 digits

    const parts = mailboxPath.split("/");
    let fsPath = `${BASE_DIR}/${accountUUID}`;
    for (let i = 0; i < parts.length - 1; i++) {
        fsPath += `/${parts[i]}.mbox`;
    }
    fsPath += `/${parts[parts.length - 1]}.mbox/${INNER_UUID}/Data/${d1}/${d2}/${d3}/Messages/${rowid}`;

    for (const suffix of [".emlx", ".partial.emlx"]) {
        if (existsSync(fsPath + suffix)) return fsPath + suffix;
    }
    return "";
}
```

**Alternative — directory scan index** (used by `apple-mail-mcp`): scan all `Messages/` directories once at startup (finds ~4,434 dirs in 0.71 s), build a `Map<rowid, path>`. Fast lookups with ~21 MB memory footprint.

### Speed

| Batch size | Direct emlx | JXA |
|---|---|---|
| 50 msgs | ~0.24 s | 30–60 s |
| 200 msgs | ~1.0 s | timeout |
| 1,000 msgs | ~4.8 s | n/a |

**Rate: ~207 msgs/sec** (Python standard `email` lib). `mailparser` npm: ~42 msgs/sec (async overhead).

### Requirements

- **Full Disk Access (FDA)** for the terminal/process — same requirement as the existing SQLite approach. `~/Library/Mail/` is FDA-protected.
- **Mail.app does NOT need to be running**
- No network access needed

---

## Approach 2 — SQLite `summaries` Table (FAST but 20% coverage)

### How it works

The Envelope Index (`~/Library/Mail/V10/MailData/Envelope Index`) has a `summaries` table containing stripped plain-text body content. It is joined to `messages` via `messages.summary → summaries.ROWID`.

```sql
SELECT m.ROWID, s.subject, sum.summary, a.address as sender
FROM messages m
JOIN subjects s ON m.subject = s.ROWID
LEFT JOIN summaries sum ON m.summary = sum.ROWID
LEFT JOIN addresses a ON m.sender = a.ROWID
WHERE m.deleted = 0 AND length(sum.summary) > 0
ORDER BY m.date_received DESC
LIMIT 1000;
```

### Speed

**~63,000 rows/sec** — 50 msgs in 1 ms. Essentially instant.

### Coverage

- 43,576 / 213,744 messages have summaries = **20.4% coverage**
- Summary max length: 4,170 chars, average ~790 chars — appears to be **full body text** (not truncated), just not populated for all messages
- Messages without summaries require falling back to emlx file reading

### Recommendation

Use as **L1 cache**: try `summaries` first, fall back to `.emlx` for misses.

---

## Approach 3 — Envelope Index Other Columns

### What exists in the database

Additional tables examined:

| Table | Relevant columns | Notes |
|-------|-----------------|-------|
| `summaries` | `summary TEXT` | 20% coverage, plain text body |
| `generated_summaries` | `summary BLOB` | Apple's AI summaries — stored as binary plist (NSAttributedString archive), not plain text. Very few entries. |
| `message_metadata` | `json_values TEXT` | Per-message metadata JSON (timestamps, flags) — no body |
| `searchable_messages` | `message_body_indexed INTEGER` | Just a flag, no body text |

### What is NOT in SQLite

The full body text is not stored in the database for 80% of messages. There is no `body`, `content`, or `preview` column in `messages`. Mail uses a hybrid model: SQLite for metadata/search index, `.emlx` files for full content.

---

## Approach 4 — Spotlight / mdfind

### Findings

- `mdfind` on `.emlx` files inside `~/Library/Mail/` returns **0 results** — Apple explicitly excludes the Mail directory from Spotlight indexing
- `mdls` on individual `.emlx` files shows `kMDItemTextContent = (null)` — Spotlight does not index emlx content
- A Spotlight plugin `Mail.mdimporter` exists at `/System/Library/Spotlight/Mail.mdimporter`, but it indexes messages into Mail's own internal search store, not the general Spotlight index
- Mail's internal search store is in `~/Library/Mail/V10/MailData/Protected Index Journals` (private format, not accessible)

**Verdict: mdfind/Spotlight is a dead end for body extraction.**

---

## Approach 5 — CoreSpotlight / CSSearchableIndex

Apple Mail's message search is implemented via a private CoreSpotlight store. The public `CSSearchableIndex` API allows apps to index their own content but does NOT provide read access to other apps' indexed content (including Mail). No programmatic access to Mail's Spotlight store is possible without private frameworks.

**Verdict: Not usable.**

---

## Approach 6 — IMAP Direct Access

Connecting to the IMAP server directly would work for online accounts but:
- Requires credentials (username/password or OAuth token)
- Requires network access (not offline-capable)
- Latency for fetching bodies from server
- Doesn't work for local/offline mailboxes

**Verdict: Only useful as last-resort fallback for messages where the emlx is missing.**

---

## Approach 7 — macOS Native Frameworks

- **MailKit** — iOS/tvOS only, not available on macOS
- **MessageUI** — iOS only
- **Message framework** — private macOS framework used by Mail.app internally. No public API. Reverse-engineered by some projects but brittle.
- **MailCore2** — third-party open-source library (C++/Obj-C) for IMAP/SMTP/MIME; can parse `.eml`/MIME directly. Available via CocoaPods/Swift Package Manager but adds significant dependency.

**Verdict: No public native macOS API for reading Mail bodies. Direct emlx parsing is simpler.**

---

## Approach 8 — Python Libraries

### `emlx` (mikez/emlx on PyPI)

Lightweight Python parser for `.emlx` files:

```python
pip install emlx
import emlx

m = emlx.read("12345.emlx")
print(m.headers['Subject'])
print(m.plist)          # Apple plist metadata
print(m.flags['read'])  # parsed flags
```

It wraps Python's standard `email.message.Message`. Under the hood, it reads the byte count, parses MIME, and decodes the plist. Essentially the same as the manual approach above, with a nicer API.

### Python standard `email` module

No dependencies needed. Already shown to be ~207 msgs/sec.

---

## Approach 9 — npm/TypeScript Libraries

### `mailparser` (nodemailer/mailparser)

- npm package `mailparser@3.9.4`
- Full MIME parser with async API
- **Speed: ~42 msgs/sec** on emlx files (async overhead dominates)
- Handles quoted-printable, base64, all charsets, nested MIME parts
- Install: `bun add mailparser @types/mailparser`

### `partial-emlx-converter` (qqilihq on npm)

- npm package `partial-emlx-converter@3.1.0`
- Converts `.partial.emlx` to standard `.eml` format
- TypeScript, handles the Apple byte-count header
- Use case: export rather than in-process parsing

### `postal-mime`

- npm package `postal-mime@2.7.4`
- Browser + Node email parser
- Fast, no external deps

---

## Approach 10 — GitHub Projects of Note

| Repo | Language | Stars | Description |
|------|----------|-------|-------------|
| `BastianZim/apple-mail-mcp` | Python | 0 | MCP server reading SQLite + emlx. Best reference implementation. |
| `qqilihq/partial-emlx-converter` | TypeScript | 89 | Convert emlx→eml, npm package |
| `kcrt/mailsearch-rust` | Rust | 0 | Full-text search TUI for Apple Mail emlx files |
| `mikez/emlx` | Python | 30 | Lightweight emlx parser library |
| `mlaiosa/emlx2maildir` | Python | 11 | Convert Apple Mail to Maildir format |

**`apple-mail-mcp` is the most relevant** — it's a complete read-only implementation using the same SQLite + emlx approach, and its source (`maildb.py`) is clean reference code.

---

## Architecture Recommendation

Tiered approach for maximum speed with full coverage:

```
Request to get body for N messages
           │
           ▼
   ┌─── L1: SQLite summaries ────────────────────────────┐
   │  SELECT summary FROM summaries WHERE ROWID = msg.summary  │
   │  ~63,000 rows/sec, 20% hit rate                          │
   └───────────────────────────────────────────────────────────┘
           │ miss (80% of messages)
           ▼
   ┌─── L2: Direct .emlx / .partial.emlx reading ─────────┐
   │  Parse MIME using Node email module or mailparser     │
   │  ~207 msgs/sec (Python) / ~42 msgs/sec (mailparser)  │
   │  Works for both .emlx and .partial.emlx files        │
   └───────────────────────────────────────────────────────┘
           │ file not found (message not cached locally)
           ▼
   ┌─── L3: JXA fallback (only if Mail.app running) ──────┐
   │  Current approach, only for uncached messages        │
   └───────────────────────────────────────────────────────┘
```

### Path resolution strategy

The `apple-mail-mcp` project's approach is the most robust: at startup, walk all `Messages/` directories (takes 0.71 s, finds 4,434 dirs), build a `Map<rowid, path>`. Then any lookup is O(1). This avoids the URL-decoding complexity and handles edge cases like nested Gmail folders automatically.

---

## Performance Summary

| Approach | Speed | Coverage | Mail.app needed | FDA needed |
|----------|-------|----------|-----------------|------------|
| JXA/osascript (current) | ~0.8 msgs/sec (50 in 30–60 s) | 100% | YES | No |
| SQLite `summaries` | ~63,000 rows/sec | 20% | No | YES |
| Direct `.emlx` reading (Python `email`) | ~207 msgs/sec | ~61% have text body | No | YES |
| Direct `.emlx` reading (`mailparser` npm) | ~42 msgs/sec | ~61% | No | YES |
| Spotlight/mdfind | 0 | 0% | No | No |
| IMAP direct | Network-limited | 100% (online) | No | No |

**Bottom line:** Replace JXA body search with direct `.emlx` reading. 125–250x speedup, no Mail.app dependency, same Full Disk Access requirement already present in the existing SQLite code.

---

## File Map

| File | Role |
|------|------|
| `~/Library/Mail/V10/MailData/Envelope Index` | SQLite DB: messages, mailboxes, subjects, addresses, summaries |
| `~/Library/Mail/V10/{uuid}/{box}.mbox/{innerUUID}/Data/{d}/{d}/{d}/Messages/{id}.emlx` | Full MIME message with text body + attachments |
| `~/Library/Mail/V10/{...}/Messages/{id}.partial.emlx` | MIME with text body; attachments not downloaded |
| `src/macos/lib/mail/jxa.ts` | Current JXA implementation (to be replaced) |
| `src/macos/lib/mail/sqlite.ts` | Existing SQLite code (already handles FDA, connection reuse) |

## Existing Codebase Context

The project already has:
- `src/macos/lib/mail/sqlite.ts` — opens `Envelope Index` read-only via `bun:sqlite`, handles FDA errors, searches by subject/sender/attachment
- `src/macos/lib/mail/jxa.ts` — current `searchBodies()` and `getMessageBody()` functions using osascript
- `src/macos/commands/mail/` — CLI commands for search, list, download

The replacement should be a new `emlx.ts` module alongside `jxa.ts` with a function like:
```typescript
export async function getMessageBodyFromEmlx(rowid: number, mailboxUrl: string): Promise<string | null>
export async function buildEmlxIndex(): Promise<Map<number, string>>  // startup scan
```

## Open Questions

1. **Inner UUID stability** — Is `42775BE5-A266-42B3-88A5-6917D019121A` consistent across all macOS Mail installations or machine-specific? The `apple-mail-mcp` project avoids this by scanning directories rather than computing paths. The scan approach is safer.

2. **Thread safety** — The SQLite connection is cached in a module-level variable. If body reading is added to the same flow, consider whether to reuse the same connection or open a separate one.

3. **Messages not on disk** — Some messages in SQLite have no corresponding `.emlx` file (remote-only). For those, either skip body or fall back to JXA (if Mail.app is running). The `download_state` column in `message_global_data` may indicate this.

4. **Attachment extraction** — `.emlx` parsing with `mailparser` gives access to attachment buffers directly. If the `download` command needs to save attachments without JXA, this is the path.
