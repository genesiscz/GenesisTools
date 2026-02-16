# Apple MCP - Comprehensive Codebase Exploration

> Repository: `supermemoryai/apple-mcp` (github.com/supermemoryai/apple-mcp)
> Author: Dhravya Shah / supermemory.ai
> License: MIT
> Version: 1.0.0 (tag)
> Explored: 2026-02-16

---

## Table of Contents

1. [Repository Overview](#repository-overview)
2. [Architecture & Design Patterns](#architecture--design-patterns)
3. [Dependencies & Runtime](#dependencies--runtime)
4. [MCP Tool Definitions & Schemas](#mcp-tool-definitions--schemas)
5. [Mail.app Integration (Detailed)](#mailapp-integration-detailed)
6. [Contacts Integration](#contacts-integration)
7. [Notes Integration](#notes-integration)
8. [Messages Integration](#messages-integration)
9. [Reminders Integration](#reminders-integration)
10. [Calendar Integration](#calendar-integration)
11. [Maps Integration](#maps-integration)
12. [Web Search (Safari-based)](#web-search-safari-based)
13. [Error Handling Patterns](#error-handling-patterns)
14. [Testing Approach](#testing-approach)
15. [What Works Well vs. What's Hacky](#what-works-well-vs-whats-hacky)
16. [Assessment: What to Adopt vs. Avoid](#assessment-what-to-adopt-vs-avoid)
17. [Reusable Patterns for Our Tool](#reusable-patterns-for-our-tool)

---

## Repository Overview

### File Structure

```
apple-mcp/
  index.ts              # MCP server entry point (1721 lines, monolithic)
  tools.ts              # MCP tool schema definitions (296 lines)
  manifest.json         # DXT extension manifest for Claude Desktop
  package.json          # Bun project, ES modules
  tsconfig.json         # TypeScript config
  apple-mcp.dxt         # Pre-built Desktop Extension (~27MB binary)
  utils/
    mail.ts             # Mail.app AppleScript integration (593 lines)
    contacts.ts         # Contacts.app AppleScript integration (420 lines)
    notes.ts            # Notes.app AppleScript integration (501 lines)
    message.ts          # Messages.app + SQLite DB integration (602 lines)
    reminders.ts        # Reminders.app AppleScript integration (390 lines)
    calendar.ts         # Calendar.app AppleScript integration (365 lines)
    maps.ts             # Maps.app JXA integration (674 lines)
    web-search.ts       # Safari-based Google search scraper (287 lines)
  tests/
    integration/        # Per-app integration tests (bun:test)
    fixtures/           # Test data constants
    helpers/            # Test utilities
```

### Key Observation: Single-File Server

The entire MCP server logic lives in `index.ts` -- a 1721-line monolith that imports
all utility modules and handles every tool call in one massive switch statement. There
is no routing layer, no middleware, and no separation of concerns beyond the utility modules.

---

## Architecture & Design Patterns

### Module Loading Strategy

The server implements a dual-mode loading strategy:

```typescript
// index.ts - Eager loading with safe-mode fallback
let useEagerLoading = true;
let safeModeFallback = false;

// Set a 5-second timeout. If eager loading exceeds it, switch to lazy loading.
loadingTimeout = setTimeout(() => {
    useEagerLoading = false;
    safeModeFallback = true;
    // Clear all module refs and init server in safe mode
    initServer();
}, 5000);

async function attemptEagerLoading() {
    contacts = (await import("./utils/contacts")).default;
    notes = (await import("./utils/notes")).default;
    message = (await import("./utils/message")).default;
    mail = (await import("./utils/mail")).default;
    reminders = (await import("./utils/reminders")).default;
    calendar = (await import("./utils/calendar")).default;
    maps = (await import("./utils/maps")).default;
    // Success: clear timeout and init normally
    initServer();
}
```

The `loadModule()` helper uses cached module references and only imports on first use
in safe mode:

```typescript
async function loadModule<T extends "contacts" | "notes" | ...>(
    moduleName: T
): Promise<ModuleMap[T]> {
    switch (moduleName) {
        case "contacts":
            if (!contacts) contacts = (await import("./utils/contacts")).default;
            return contacts as ModuleMap[T];
        // ... etc for each module
    }
}
```

**Assessment**: This is over-engineered for a Bun project where imports are fast. The
timeout fallback adds complexity without clear benefit. A simpler approach would be
lazy-on-demand or just eager with no fallback.

### stdout Filtering

The server intercepts stdout to prevent non-JSON data from corrupting the MCP stdio
transport:

```typescript
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
    if (typeof chunk === "string" && !chunk.startsWith("{")) {
        console.error("Filtering non-JSON stdout message");
        return true; // Silently skip
    }
    return originalStdoutWrite(chunk, encoding, callback);
};
```

**Assessment**: Smart defensive measure. AppleScript can sometimes produce unexpected
stdout output. Worth adopting.

### Type Guards (Argument Validation)

Each tool has a manual type guard function:

```typescript
function isMailArgs(args: unknown): args is {
    operation: "unread" | "search" | "send" | "mailboxes" | "accounts" | "latest";
    account?: string;
    mailbox?: string;
    limit?: number;
    // ...
} {
    if (typeof args !== "object" || args === null) return false;
    const { operation } = args as any;
    if (!["unread", "search", "send", ...].includes(operation)) return false;
    // ... field-specific validation per operation
    return true;
}
```

**Assessment**: These are verbose and repetitive. They could be replaced with Zod
schemas (which is already a dependency but unused for validation). The tool definitions
in `tools.ts` use JSON Schema but validation is duplicated in the type guards.

---

## Dependencies & Runtime

```json
{
    "dependencies": {
        "@hono/node-server": "^1.13.8",      // Unused? No HTTP server visible
        "@jxa/global-type": "^1.3.6",         // JXA type definitions
        "@jxa/run": "^1.3.6",                 // JXA runner (used by maps.ts)
        "@modelcontextprotocol/sdk": "^1.5.0", // MCP SDK
        "@types/express": "^5.0.0",           // Unused? No express in code
        "mcp-proxy": "^2.4.0",               // MCP proxy (not seen in code)
        "run-applescript": "^7.0.0",          // AppleScript runner
        "zod": "^3.24.2"                      // Zod (unused in actual code!)
    }
}
```

**Key Libraries**:
- `run-applescript` -- Executes AppleScript strings via `osascript`. Returns string results.
- `@jxa/run` -- Executes JavaScript for Automation (JXA). Used only by Maps module.
- `@modelcontextprotocol/sdk` -- Official MCP SDK for stdio transport.

**Runtime**: Bun (but builds to Node.js target via `bun build --target=node`).

**Unused Dependencies**: `@hono/node-server`, `@types/express`, `zod`, `mcp-proxy` are
all listed but not used in the actual source code. Classic dependency cruft.

---

## MCP Tool Definitions & Schemas

Defined in `tools.ts`. Each tool uses the `operation` pattern -- a single tool per Apple
app with an `operation` enum that dispatches to sub-functionality.

### Tool Summary

| Tool | Operations | Required Fields |
|------|-----------|----------------|
| `contacts` | (none - implicit search/list) | `name?` |
| `notes` | `search`, `list`, `create` | `operation` + operation-specific |
| `messages` | `send`, `read`, `schedule`, `unread` | `operation` + operation-specific |
| `mail` | `unread`, `search`, `send`, `mailboxes`, `accounts`, `latest` | `operation` + operation-specific |
| `reminders` | `list`, `search`, `open`, `create`, `listById` | `operation` + operation-specific |
| `calendar` | `search`, `open`, `list`, `create` | `operation` + operation-specific |
| `maps` | `search`, `save`, `directions`, `pin`, `listGuides`, `addToGuide`, `createGuide` | `operation` + operation-specific |

### Mail Tool Schema (Full)

```typescript
const MAIL_TOOL: Tool = {
    name: "mail",
    description: "Interact with Apple Mail app - read unread emails, search emails, and send emails",
    inputSchema: {
        type: "object",
        properties: {
            operation: {
                type: "string",
                description: "Operation to perform: 'unread', 'search', 'send', 'mailboxes', 'accounts', or 'latest'",
                enum: ["unread", "search", "send", "mailboxes", "accounts", "latest"]
            },
            account: {
                type: "string",
                description: "Email account to use (optional)"
            },
            mailbox: {
                type: "string",
                description: "Mailbox to use (optional)"
            },
            limit: {
                type: "number",
                description: "Number of emails to retrieve (optional)"
            },
            searchTerm: {
                type: "string",
                description: "Text to search for in emails (required for search)"
            },
            to: { type: "string", description: "Recipient (required for send)" },
            subject: { type: "string", description: "Subject (required for send)" },
            body: { type: "string", description: "Body (required for send)" },
            cc: { type: "string", description: "CC (optional for send)" },
            bcc: { type: "string", description: "BCC (optional for send)" }
        },
        required: ["operation"]
    }
};
```

**Design Choice**: One "mega-tool" per app rather than individual tools per operation.
This means the LLM sees 7 tools instead of ~30+, but each tool has complex conditional
parameters. The `operation` field acts as a sub-command dispatcher.

---

## Mail.app Integration (Detailed)

**File**: `utils/mail.ts` (593 lines)
**Approach**: AppleScript via `run-applescript`
**Interface**:

```typescript
interface EmailMessage {
    subject: string;
    sender: string;
    dateSent: string;
    content: string;
    isRead: boolean;
    mailbox: string;
}
```

### Configuration

```typescript
const CONFIG = {
    MAX_EMAILS: 20,            // Hard cap on emails processed
    MAX_CONTENT_PREVIEW: 300,  // Characters of body content
    TIMEOUT_MS: 10000,         // 10 second timeout (not enforced)
};
```

### Access Check Pattern

Every mail function calls `requestMailAccess()` first:

```typescript
async function checkMailAccess(): Promise<boolean> {
    try {
        const script = `
tell application "Mail"
    return name
end tell`;
        await runAppleScript(script);
        return true;
    } catch (error) {
        return false;
    }
}

async function requestMailAccess(): Promise<{ hasAccess: boolean; message: string }> {
    const hasAccess = await checkMailAccess();
    if (hasAccess) return { hasAccess: true, message: "Mail access is already granted." };

    return {
        hasAccess: false,
        message: "Mail access is required but not granted. Please:\n"
            + "1. Open System Settings > Privacy & Security > Automation\n"
            + "2. Find your terminal/app in the list and enable 'Mail'\n"
            + "3. Make sure Mail app is running and configured\n"
            + "4. Restart your terminal and try again"
    };
}
```

**Assessment**: Good UX pattern -- providing actionable instructions when access fails.
However, calling `checkMailAccess()` on EVERY operation is wasteful. Could cache the
result after first successful check.

### Get Unread Emails

```applescript
tell application "Mail"
    set emailList to {}
    set emailCount to 0

    set allMailboxes to mailboxes

    repeat with i from 1 to (count of allMailboxes)
        if emailCount >= ${maxEmails} then exit repeat

        try
            set currentMailbox to item i of allMailboxes
            set mailboxName to name of currentMailbox

            set unreadMessages to messages of currentMailbox

            repeat with j from 1 to (count of unreadMessages)
                if emailCount >= ${maxEmails} then exit repeat

                try
                    set currentMsg to item j of unreadMessages

                    if read status of currentMsg is false then
                        set emailSubject to subject of currentMsg
                        set emailSender to sender of currentMsg
                        set emailDate to (date sent of currentMsg) as string

                        set emailContent to ""
                        try
                            set fullContent to content of currentMsg
                            if (length of fullContent) > 300 then
                                set emailContent to (characters 1 thru 300 of fullContent) as string
                                set emailContent to emailContent & "..."
                            else
                                set emailContent to fullContent
                            end if
                        on error
                            set emailContent to "[Content not available]"
                        end try

                        set emailInfo to {subject:emailSubject, sender:emailSender, ...}
                        set emailList to emailList & {emailInfo}
                        set emailCount to emailCount + 1
                    end if
                on error
                    -- Skip problematic messages
                end try
            end repeat
        on error
            -- Skip problematic mailboxes
        end try
    end repeat

    return "SUCCESS:" & (count of emailList)
end tell
```

**CRITICAL BUG**: The AppleScript collects emails into `emailList` but then returns
only `"SUCCESS:" & (count of emailList)` -- a string like `"SUCCESS:5"`. The actual
email data is **discarded**. The TypeScript code then checks for this prefix and
returns an empty array:

```typescript
const result = await runAppleScript(script) as string;
if (result && result.startsWith("SUCCESS:")) {
    // For now, return empty array as the actual email parsing
    // from AppleScript is complex
    return [];
}
```

This means `getUnreadMails()` and `searchMails()` **always return empty arrays**.
The functions are effectively non-functional for their primary purpose.

### Search Emails

Same pattern as unread -- iterates all mailboxes, filters by `subject contains searchTerm`,
but also returns `"SUCCESS:<count>"` and then returns `[]`.

```applescript
-- Simple case-insensitive search in subject
if emailSubject contains searchTerm then
    -- ... collect email info
end if
```

**Limitation**: Only searches the `subject` field. Does not search `content` or `sender`.
AppleScript's `contains` is case-insensitive on macOS but the search term is pre-lowered
in TypeScript anyway.

### Send Email

This is the most functional mail operation. Uses a file-based approach to handle
body content with special characters:

```typescript
async function sendMail(to, subject, body, cc?, bcc?) {
    // Write body to temp file to avoid AppleScript escaping issues
    const tmpFile = `/tmp/email-body-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, body.trim(), "utf8");

    const script = `
tell application "Mail"
    activate

    -- Read email body from file to preserve formatting
    set emailBody to read file POSIX file "${tmpFile}" as <<class utf8>>

    set newMessage to make new outgoing message with properties ¬
        {subject:"${subject.replace(/"/g, '\\"')}", content:emailBody, visible:true}

    tell newMessage
        make new to recipient with properties {address:"${to.replace(/"/g, '\\"')}"}
        ${cc ? `make new cc recipient with properties {address:"${cc}"}` : ""}
        ${bcc ? `make new bcc recipient with properties {address:"${bcc}"}` : ""}
    end tell

    send newMessage
    return "SUCCESS"
end tell`;

    const result = await runAppleScript(script);
    // Clean up temp file
    fs.unlinkSync(tmpFile);
    return `Email sent to ${to} with subject "${subject}"`;
}
```

**Good patterns here**:
- Temp file for body content avoids AppleScript string escaping nightmares
- `activate` ensures Mail.app is running
- `visible:true` lets user verify before sending
- Proper cleanup of temp files

**Bad patterns**:
- Only handles single `to`/`cc`/`bcc` -- no comma-separated multiple recipients
- No HTML email support
- Uses `require("fs")` (CJS) instead of `import` (should use Bun.file)
- Basic string escaping with only `"` replacement -- breaks on backslashes, newlines

### Get Mailboxes (Fake Implementation)

```applescript
tell application "Mail"
    try
        set mailboxCount to count of mailboxes
        if mailboxCount > 0 then
            return {"Inbox", "Sent", "Drafts"}
        else
            return {}
        end if
    on error
        return {}
    end try
end tell
```

**This is hardcoded**. It always returns `["Inbox", "Sent", "Drafts"]` regardless of
the actual mailboxes. The real mailbox names are never queried.

### Get Accounts (Fake Implementation)

```applescript
tell application "Mail"
    try
        set accountCount to count of accounts
        if accountCount > 0 then
            return {"Default Account"}
        else
            return {}
        end if
    on error
        return {}
    end try
end tell
```

**Also hardcoded**. Always returns `["Default Account"]` regardless of actual account
names. This breaks the `getLatestMails()` function which uses the account name in
a `first account whose name is "..."` query.

### Get Latest Emails (Partially Working)

This function actually attempts to return data by parsing AppleScript record output:

```typescript
const emailData = [];
const matches = asResult.match(/\{([^}]+)\}/g);
if (matches && matches.length > 0) {
    for (const match of matches) {
        const props = match.substring(1, match.length - 1).split(",");
        const email: any = {};
        props.forEach((prop) => {
            const parts = prop.split(":");
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join(":").trim();
                email[key] = value;
            }
        });
        if (email.subject || email.sender) {
            emailData.push({
                subject: email.subject || "No subject",
                sender: email.sender || "Unknown sender",
                dateSent: email.date || new Date().toString(),
                content: email.content || "[Content not available]",
                isRead: false,
                mailbox: `${account} - ${email.mailbox || "Unknown"}`,
            });
        }
    }
}
```

**Parsing approach**: Regex-based extraction of `{key:value, key:value}` records from
AppleScript's string representation. This is fragile because:
- Email subjects containing `{` or `}` break the regex
- Values containing commas break the split
- Values containing colons break the key/value split
- No escaping is handled

The AppleScript also references `sortMessagesByDate` as a custom handler:

```applescript
on sortMessagesByDate(messagesList)
    set sortedMessages to sort messagesList by date sent
    return sortedMessages
end sortMessagesByDate
```

This will fail because `sort ... by date sent` is not valid AppleScript syntax. The
correct approach would be to use a bubble sort or use `whose` filtering.

### Unread Emails (Account-Specific, in index.ts)

When an account name is provided for the "unread" operation, `index.ts` contains an
inline AppleScript (not in the mail utility module):

```applescript
tell application "Mail"
    set resultList to {}
    try
        set targetAccount to first account whose name is "${args.account}"

        set acctMailboxes to every mailbox of targetAccount

        -- Optional mailbox filter
        ${args.mailbox ? `
        set mailboxesToSearch to {}
        repeat with mb in acctMailboxes
            if name of mb is "${args.mailbox}" then
                set mailboxesToSearch to {mb}
                exit repeat
            end if
        end repeat
        ` : ""}

        repeat with mb in mailboxesToSearch
            try
                set unreadMessages to (messages of mb whose read status is false)
                -- ... process up to limit ...
            end try
        end repeat
    on error errMsg
        return "Error: " & errMsg
    end try
    return resultList
end tell
```

This is a code smell -- the account-specific unread logic is in `index.ts` rather than
in `utils/mail.ts`, creating an inconsistency in the architecture.

### Mail Summary

| Operation | Works? | Notes |
|-----------|--------|-------|
| `getUnreadMails()` | NO | Always returns `[]` -- data is discarded |
| `searchMails()` | NO | Always returns `[]` -- data is discarded |
| `sendMail()` | YES | File-based body, basic but functional |
| `getMailboxes()` | FAKE | Returns hardcoded `["Inbox","Sent","Drafts"]` |
| `getAccounts()` | FAKE | Returns hardcoded `["Default Account"]` |
| `getMailboxesForAccount()` | YES | Actually queries AppleScript |
| `getLatestMails()` | PARTIAL | Fragile regex parsing of AppleScript output |
| Account-specific unread | PARTIAL | Inline in index.ts, same parsing issues |

---

## Contacts Integration

**File**: `utils/contacts.ts` (420 lines)
**Approach**: AppleScript via `run-applescript`

### Key Functions

**getAllNumbers()** -- Gets all contacts with phone numbers:

```applescript
tell application "Contacts"
    set contactList to {}
    set contactCount to 0
    set allPeople to people

    repeat with i from 1 to (count of allPeople)
        if contactCount >= 1000 then exit repeat
        try
            set currentPerson to item i of allPeople
            set personName to name of currentPerson
            set personPhones to {}

            try
                set phonesList to phones of currentPerson
                repeat with phoneItem in phonesList
                    try
                        set phoneValue to value of phoneItem
                        if phoneValue is not "" then
                            set personPhones to personPhones & {phoneValue}
                        end if
                    on error
                    end try
                end repeat
            on error
            end try

            if (count of personPhones) > 0 then
                set contactInfo to {name:personName, phones:personPhones}
                set contactList to contactList & {contactInfo}
                set contactCount to contactCount + 1
            end if
        on error
        end try
    end repeat
    return contactList
end tell
```

**findNumber(name)** -- Fuzzy contact search with multi-strategy fallback:

The search uses AppleScript for initial lookup, then falls back to a sophisticated
TypeScript fuzzy matching system with 8 strategies:

```typescript
const strategies = [
    // 1. Exact match (case insensitive)
    (personName) => cleanName(personName) === searchName,
    // 2. Exact match with cleaned names (remove emoji, etc.)
    (personName) => cleanName(personName) === cleanName(name),
    // 3. Starts with search term
    (personName) => cleanName(personName).startsWith(searchName),
    // 4. Contains search term
    (personName) => cleanName(personName).includes(searchName),
    // 5. Search term contains person name (nicknames)
    (personName) => searchName.includes(cleanName(personName)),
    // 6. First name match with deduplication
    // 7. Last name match
    // 8. Substring match in any word
];
```

The `cleanName()` function strips emoji and special characters:

```typescript
const cleanName = (name: string) => {
    return name.toLowerCase()
        .replace(/[\u{1F600}-\u{1F64F}]|.../gu, "")  // Remove emoji
        .replace(/[...]/g, "")                          // Remove hearts/symbols
        .replace(/\s+/g, " ")
        .trim();
};
```

**findContactByPhone(phoneNumber)** -- Reverse lookup by phone number with normalized
comparison. Uses both AppleScript and fallback to `getAllNumbers()`.

### Assessment

The contacts module is the most well-implemented utility. The multi-strategy fuzzy
search is genuinely useful for handling emoji in names, nicknames, and partial matches.
The phone number normalization handles various formats (+1, 1, raw 10 digits).

---

## Notes Integration

**File**: `utils/notes.ts` (501 lines)
**Approach**: AppleScript via `run-applescript`

### Key Operations

**getAllNotes()** -- Lists notes with content preview:

```applescript
tell application "Notes"
    set notesList to {}
    repeat with i from 1 to (count of allNotes)
        if noteCount >= 50 then exit repeat
        try
            set currentNote to item i of allNotes
            set noteName to name of currentNote
            set noteContent to plaintext of currentNote
            -- Truncate to 200 chars
            if (length of noteContent) > 200 then
                set noteContent to (characters 1 thru 200 of noteContent) as string & "..."
            end if
            set noteInfo to {name:noteName, content:noteContent}
            set notesList to notesList & {noteInfo}
        on error
        end try
    end repeat
    return notesList
end tell
```

**findNote(searchText)** -- Searches both name and content:

```applescript
if (noteName contains searchTerm) or (noteContent contains searchTerm) then
    -- ... add to results
end if
```

**createNote(title, body, folderName)** -- Creates note with folder management:

Uses the temp file pattern (same as mail send) for body content:

```typescript
const tmpFile = `/tmp/note-content-${Date.now()}.txt`;
fs.writeFileSync(tmpFile, formattedBody, "utf8");
```

The AppleScript attempts to find or create the target folder:

```applescript
-- Try to find the specified folder
set allFolders to folders
repeat with currentFolder in allFolders
    if name of currentFolder is "Claude" then
        set targetFolder to currentFolder
        set folderFound to true
        exit repeat
    end if
end repeat

-- If folder not found, try to create it
if not folderFound then
    try
        make new folder with properties {name:"Claude"}
    end try
end if

-- Read content from temp file
set noteContent to read file POSIX file "/tmp/note-content-xxx.txt" as <<class utf8>>

-- Create note in folder or default location
if folderFound then
    make new note at targetFolder with properties {name:"Title", body:noteContent}
else
    make new note with properties {name:"Title", body:noteContent}
end if
```

**Result parsing**: Uses a `"SUCCESS:folderName:usedDefault"` string protocol:

```typescript
if (result.startsWith("SUCCESS:")) {
    const parts = result.split(":");
    const folderName = parts[1] || "Notes";
    const usedDefaultFolder = parts[2] === "true";
    return { success: true, folderName, usedDefaultFolder };
}
```

### Unused Functions

`getNotesFromFolder()`, `getRecentNotesFromFolder()`, and `getNotesByDateRange()` are
defined but return empty arrays or delegate with no actual implementation. Date filtering
is marked as "too complex for AppleScript."

---

## Messages Integration

**File**: `utils/message.ts` (602 lines)
**Approach**: Hybrid -- AppleScript for sending, SQLite for reading

This is the most interesting module architecturally because it uses **two different
data access methods**:

### Sending (AppleScript)

```applescript
tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${phoneNumber}"
    send "${escapedMessage}" to targetBuddy
end tell
```

Simple and direct. Only handles iMessage, not SMS.

### Reading (SQLite Direct Access)

Messages are read directly from the Messages database at
`~/Library/Messages/chat.db`:

```typescript
const query = `
    SELECT
        m.ROWID as message_id,
        CASE
            WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
            WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
            ELSE NULL
        END as content,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'),
                 'unixepoch', 'localtime') as date,
        h.id as sender,
        m.is_from_me,
        m.is_audio_message,
        m.cache_has_attachments,
        m.subject,
        CASE
            WHEN m.text IS NOT NULL AND m.text != '' THEN 0
            WHEN m.attributedBody IS NOT NULL THEN 1
            ELSE 2
        END as content_type
    FROM message m
    INNER JOIN handle h ON h.ROWID = m.handle_id
    WHERE h.id IN (${phoneList})
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL
             OR m.cache_has_attachments = 1)
        AND m.is_from_me IS NOT NULL
        AND m.item_type = 0
        AND m.is_audio_message = 0
    ORDER BY m.date DESC
    LIMIT ${maxLimit}
`;

const { stdout } = await execAsync(
    `sqlite3 -json "${process.env.HOME}/Library/Messages/chat.db" "${query}"`
);
```

**Key insight**: Messages.app's AppleScript dictionary is extremely limited -- you
cannot read message history via AppleScript. The only way to access message history is
through the SQLite database, which requires Full Disk Access permission.

### Date Conversion

macOS Messages uses "Core Data timestamp" -- nanoseconds since 2001-01-01:

```sql
datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime')
```

### AttributedBody Decoding

When a message has no plain `text` but has `attributedBody` (rich text), the code
hex-encodes it and decodes in TypeScript:

```typescript
function decodeAttributedBody(hexString: string): { text: string; url?: string } {
    const buffer = Buffer.from(hexString, 'hex');
    const content = buffer.toString();

    // Try multiple regex patterns to extract text
    const patterns = [
        /NSString">(.*?)</,
        /NSString">([^<]+)/,
        /"string":\s*"([^"]+)"/,
        // ... etc
    ];

    // Also extract URLs
    const urlPatterns = [
        /(https?:\/\/[^\s<"]+)/,
        /NSString">(https?:\/\/[^\s<"]+)/,
        // ... etc
    ];

    // Fallback: clean non-printable chars
    const readableText = content
        .replace(/[^\x20-\x7E]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
```

**Assessment**: This is hacky but necessary. `attributedBody` is a binary NSArchiver
plist format. Converting to hex and regex-matching is unreliable. A better approach
would be to use `plutil` or `plistlib` to properly decode the NSKeyedArchiver data.

### Phone Number Normalization

```typescript
function normalizePhoneNumber(phone: string): string[] {
    const cleaned = phone.replace(/[^0-9+]/g, '');

    if (/^\+1\d{10}$/.test(cleaned)) return [cleaned];
    if (/^1\d{10}$/.test(cleaned))   return [`+${cleaned}`];
    if (/^\d{10}$/.test(cleaned))    return [`+1${cleaned}`];

    // Fallback: try multiple formats
    const formats = new Set<string>();
    // ... generate variations
    return Array.from(formats);
}
```

US-centric but handles common formats well.

### Scheduled Messages

Uses `setTimeout` in-process -- messages are lost if the server restarts:

```typescript
async function scheduleMessage(phoneNumber, message, scheduledTime) {
    const delay = scheduledTime.getTime() - Date.now();
    if (delay < 0) throw new Error('Cannot schedule message in the past');

    const timeoutId = setTimeout(async () => {
        await sendMessage(phoneNumber, message);
    }, delay);

    return { id: timeoutId, scheduledTime, message, phoneNumber };
}
```

**Assessment**: This is unreliable for any serious use. No persistence, no retry, no
confirmation. The `scheduledMessages` map is created locally inside the function and
garbage collected immediately.

### Retry Logic

Has a generic retry helper for SQLite operations:

```typescript
async function retryOperation<T>(
    operation: () => Promise<T>,
    retries = 3,
    delay = 1000
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (retries > 0) {
            await sleep(delay);
            return retryOperation(operation, retries - 1, delay);
        }
        throw error;
    }
}
```

---

## Reminders Integration

**File**: `utils/reminders.ts` (390 lines)
**Approach**: AppleScript via `run-applescript`

### Key Observation: Mostly Stubbed

Most Reminders functions are **stubbed out for performance**:

```typescript
// getAllReminders - STUBBED
const script = `
tell application "Reminders"
    try
        set listCount to count of lists
        if listCount > 0 then
            return "SUCCESS:found_lists_but_reminders_query_too_slow"
        end if
    end try
end tell`;

// searchReminders - STUBBED
return "SUCCESS:reminder_search_not_implemented_for_performance"

// getRemindersFromListById - STUBBED
return "SUCCESS:reminders_by_id_not_implemented_for_performance"
```

**Only functional operations**:
- `getAllLists()` -- Returns list names and IDs (works)
- `createReminder()` -- Creates a simple reminder in the first available list (works,
  but ignores `listName`, `notes`, and `dueDate` parameters)

The create function:

```applescript
tell application "Reminders"
    try
        set allLists to lists
        if (count of allLists) > 0 then
            set targetList to first item of allLists
            set listName to name of targetList
            set newReminder to make new reminder at targetList with properties {name:"..."}
            return "SUCCESS:" & listName
        else
            return "ERROR:No lists available"
        end if
    on error errorMessage
        return "ERROR:" & errorMessage
    end try
end tell
```

**Assessment**: The Reminders module is essentially a placeholder. Only list enumeration
and basic creation work. The author encountered AppleScript performance issues with
Reminders queries and gave up implementing full functionality.

---

## Calendar Integration

**File**: `utils/calendar.ts` (365 lines)
**Approach**: AppleScript via `run-applescript`

### Key Operations

**getEvents()** -- STUBBED. Returns a dummy event:

```applescript
tell application "Calendar"
    set eventList to {}
    try
        set testEvent to {}
        set testEvent to testEvent & {id:"dummy-event-1"}
        set testEvent to testEvent & {title:"No events available - Calendar operations too slow"}
        -- ... returns dummy data
    end try
    return eventList
end tell
```

**searchEvents()** -- STUBBED. Returns empty list:

```applescript
tell application "Calendar"
    set eventList to {}
    -- Return empty list for search (Calendar queries are too slow)
    return eventList
end tell
```

**createEvent()** -- FUNCTIONAL. Actually creates calendar events:

```applescript
tell application "Calendar"
    set startDate to date "${start.toLocaleString()}"
    set endDate to date "${end.toLocaleString()}"

    set targetCal to null
    try
        set targetCal to calendar "Calendar"
    on error
        set targetCal to first calendar
    end try

    tell targetCal
        set newEvent to make new event with properties ¬
            {summary:"${title}", start date:startDate, end date:endDate, ¬
             allday event:${isAllDay}}

        if "${location}" is not "" then
            set location of newEvent to "${location}"
        end if

        if "${notes}" is not "" then
            set description of newEvent to "${notes}"
        end if

        return uid of newEvent
    end tell
end tell
```

**Bug**: The date parsing uses `toLocaleString()` which produces locale-dependent
output. This breaks on non-English locales where the date format is different.

**openEvent()** -- Opens Calendar.app but does not navigate to the specific event:

```applescript
tell application "Calendar"
    activate
    return "Calendar app opened (event search too slow)"
end tell
```

### Assessment

Like Reminders, Calendar is mostly non-functional. Only event creation works. The
queries for listing and searching events were apparently too slow and the author stubbed
them out.

---

## Maps Integration

**File**: `utils/maps.ts` (674 lines)
**Approach**: JXA (JavaScript for Automation) via `@jxa/run`

This is the only module that uses JXA instead of AppleScript. JXA allows writing
automation scripts in JavaScript:

```typescript
import { run } from '@jxa/run';

const locations = await run((args) => {
    const Maps = Application("Maps");
    Maps.activate();
    const encodedQuery = encodeURIComponent(args.query);
    Maps.openLocation(`maps://?q=${encodedQuery}`);

    try {
        Maps.search(args.query);
    } catch (e) {}

    delay(2); // Wait for results

    // Try to get selected location
    try {
        const selectedLocation = Maps.selectedLocation();
        if (selectedLocation) {
            return [{
                id: `loc-${Date.now()}`,
                name: selectedLocation.name(),
                address: selectedLocation.formattedAddress(),
                latitude: selectedLocation.latitude(),
                longitude: selectedLocation.longitude(),
                // ...
            }];
        }
    } catch (e) {}

    return [{ name: args.query, address: "Search result - not available" }];
}, { query, limit });
```

**Key patterns**:
- Uses `maps://` URL scheme for search operations
- `delay(2)` -- waits 2 seconds for Maps to load results
- Graceful degradation -- if API calls fail, returns minimal results
- All "guide" operations (`listGuides`, `createGuide`, `addToGuide`) just open the Maps
  UI and provide textual instructions to the user

### Directions

```typescript
const result = await run((args) => {
    const Maps = Application("Maps");
    Maps.activate();
    Maps.getDirections({
        from: args.fromAddress,
        to: args.toAddress,
        by: args.transportType
    });
    delay(2);
    return {
        success: true,
        message: `Displaying directions from "${args.fromAddress}" to "${args.toAddress}"`,
        route: { distance: "See Maps app for details", duration: "See Maps app for details" }
    };
}, { fromAddress, toAddress, transportType });
```

**Assessment**: Maps module is the most "honest" about its limitations. It opens the
Maps UI and tells the user what to do manually, rather than pretending to have
functionality it does not have.

---

## Web Search (Safari-based)

**File**: `utils/web-search.ts` (287 lines)
**Approach**: AppleScript controlling Safari + JavaScript injection

This module is not exposed as an MCP tool in the current version but provides a
creative Safari-based Google search:

1. Opens Safari with `activate` and `make new document`
2. Sets a custom user agent
3. Navigates to Google search URL
4. Injects JavaScript to extract search results from Google's DOM
5. Navigates to each result URL
6. Injects JavaScript to extract page content
7. Closes Safari

```applescript
tell application "Safari"
    set jsResult to do JavaScript "..." in document 1
    return jsResult
end tell
```

**Assessment**: Creative but fragile. Google's DOM changes frequently and the selectors
(`div.g`, `div[data-sokoban-container]`) will break. Also opens a visible Safari window
which is intrusive. Not suitable for production use.

---

## Error Handling Patterns

### Access Check + Instructions

Every module follows this pattern:

```typescript
async function requestXxxAccess(): Promise<{ hasAccess: boolean; message: string }> {
    const hasAccess = await checkXxxAccess();
    if (hasAccess) return { hasAccess: true, message: "..." };
    return {
        hasAccess: false,
        message: "Access required. Steps:\n1. Open System Settings...\n2. ..."
    };
}

// Used at the start of every operation:
const accessResult = await requestXxxAccess();
if (!accessResult.hasAccess) {
    throw new Error(accessResult.message);
}
```

### AppleScript Error Swallowing

All AppleScript loops use `on error` blocks to silently skip problematic items:

```applescript
try
    set currentMsg to item j of unreadMessages
    -- ... process message
on error
    -- Skip problematic messages
end try
```

This hides errors but prevents one bad message from blocking all results.

### MCP Error Response Format

In `index.ts`, all tool handlers return the MCP error format:

```typescript
return {
    content: [{ type: "text", text: `Error: ${errorMessage}` }],
    isError: true,
};
```

With a special check for access-related errors to preserve the instructional message:

```typescript
const errorMessage = error instanceof Error ? error.message : String(error);
return {
    content: [{
        type: "text",
        text: errorMessage.includes("access") ? errorMessage
            : `Error with mail operation: ${errorMessage}`,
    }],
    isError: true,
};
```

---

## Testing Approach

Tests are integration tests using `bun:test` that run against the actual macOS apps:

```typescript
import { describe, it, expect } from "bun:test";
import mailModule from "../../utils/mail.js";

describe("Mail Integration Tests", () => {
    it("should retrieve email accounts", async () => {
        const accounts = await mailModule.getAccounts();
        expect(Array.isArray(accounts)).toBe(true);
        // ... logs but tolerates empty results
    }, 15000); // 15 second timeout
});
```

**Characteristics**:
- All tests are tolerant of empty results ("No accounts found - this is normal")
- High timeouts (10-30 seconds) for AppleScript operations
- Test data uses placeholder values (`test@example.com`, `+1 9999999999`)
- Send tests actually send real emails/messages (no mocking)
- Tests require macOS with Full Disk Access and Automation permissions

---

## What Works Well vs. What's Hacky

### Works Well

1. **Messages SQLite approach** -- Reading the chat.db directly is the correct way to
   access message history. The schema knowledge (Core Data timestamps, handle joins,
   attributedBody decoding) is valuable.

2. **Contacts fuzzy search** -- The 8-strategy fuzzy matching with emoji removal is
   genuinely useful and handles real-world contact name messiness.

3. **Send email file-based body** -- Writing email body to temp file before passing to
   AppleScript avoids all string escaping issues.

4. **Access check with instructions** -- Returning actionable permission-fix steps when
   access is denied is excellent UX for MCP tools.

5. **stdout filtering** -- Intercepting stdout to prevent non-JSON output from corrupting
   the MCP transport is a smart defensive measure.

6. **Maps JXA approach** -- Using JXA instead of AppleScript for Maps is cleaner and
   more maintainable. The typed function signatures are easier to work with.

### Hacky / Broken

1. **Mail getUnreadMails/searchMails always return []** -- The data is collected in
   AppleScript but the return value discards it. These are the two most important mail
   operations and they do not work.

2. **Hardcoded getMailboxes/getAccounts** -- Returns fake data instead of querying
   real mailboxes/accounts. Breaks downstream operations.

3. **Calendar/Reminders mostly stubbed** -- Most operations return empty results or
   dummy data with comments about being "too slow."

4. **AppleScript output parsing** -- Using regex on AppleScript's string representation
   of records is inherently fragile. Fields containing delimiters break parsing.

5. **attributedBody hex decoding** -- Converting to hex and regex-matching NSArchiver
   data is unreliable. Proper plist decoding would be more robust.

6. **Scheduled messages in setTimeout** -- Lost on server restart, no persistence.

7. **Massive index.ts monolith** -- 1721 lines of switch/case logic with inline
   AppleScript. Should be decomposed into per-app handlers.

8. **Unused dependencies** -- zod, hono, express types, mcp-proxy are all installed
   but never used.

9. **Date handling with toLocaleString()** -- Calendar event creation passes locale-
   dependent date strings to AppleScript, which breaks on non-US locales.

10. **Web search via Safari** -- Opens visible Safari windows, injects JS into Google,
    uses fragile DOM selectors. Not production-ready.

---

## Assessment: What to Adopt vs. Avoid

### ADOPT for our `src/macos-mail/` tool

1. **Messages SQLite pattern** -- Direct database access is the reliable way to read
   message history. The schema knowledge (chat.db structure, Core Data timestamps,
   handle table joins) is directly transferable.

2. **File-based content passing** -- Writing email/note bodies to temp files before
   passing to AppleScript is the correct solution for escaping issues. Adopt this
   pattern for any AppleScript that needs to handle user-provided text.

3. **Access check + instructions pattern** -- Check permission first, return actionable
   fix steps on failure. Wrap this into a reusable utility.

4. **stdout filtering** -- If running as MCP server, filter non-JSON stdout.

5. **Phone number normalization** -- The multi-format normalization is useful if we
   ever integrate with Contacts.

6. **JXA over AppleScript** -- For apps that support it, JXA is cleaner than AppleScript
   strings. Use `@jxa/run` for new integrations.

### AVOID / Do Differently

1. **Do NOT use AppleScript record parsing with regex** -- Instead, structure AppleScript
   to return delimited strings (e.g., `|||` separator) or use JSON generation:

   ```applescript
   -- Better: return as JSON string
   set jsonResult to "["
   repeat with msg in messages
       set jsonResult to jsonResult & "{\"subject\":\"" & subject of msg & "\"},"
   end repeat
   set jsonResult to jsonResult & "]"
   return jsonResult
   ```

   Or even better, use `osascript -l JavaScript` (JXA) which natively outputs JSON.

2. **Do NOT stub operations** -- If a feature is too slow, either optimize it (e.g.,
   use `whose` clause instead of iterating), document the limitation clearly, or don't
   expose the tool at all. Returning empty results silently is worse than an error.

3. **Do NOT hardcode fake data** -- The `getMailboxes()` returning `["Inbox","Sent","Drafts"]`
   is misleading. Either implement it properly or throw a "not implemented" error.

4. **Do NOT put business logic in the MCP handler** -- The account-specific unread email
   logic is in `index.ts` instead of `utils/mail.ts`. Keep all app-specific logic in
   the utility modules.

5. **Do NOT use single mega-tools** -- The `operation` enum pattern makes tools harder
   for LLMs to use correctly. Prefer individual tools: `mail_search`, `mail_send`,
   `mail_unread`, etc.

6. **Do NOT use `toLocaleString()` for dates** -- Use ISO format or explicit format
   strings for AppleScript date parsing.

7. **Do NOT use `require("fs")` in ESM** -- Use `import { writeFileSync } from "fs"`
   or Bun's `Bun.write()`.

---

## Reusable Patterns for Our Tool

### Pattern 1: AppleScript Runner with Error Handling

```typescript
import { runAppleScript } from "run-applescript";

async function runMailScript<T>(script: string, parser: (result: string) => T): Promise<T> {
    const accessResult = await checkMailAccess();
    if (!accessResult.hasAccess) {
        throw new Error(accessResult.message);
    }

    const raw = await runAppleScript(script);
    return parser(raw);
}
```

### Pattern 2: Safe Content Passing via Temp File

```typescript
async function withTempContent<T>(
    content: string,
    callback: (filePath: string) => Promise<T>
): Promise<T> {
    const tmpFile = `/tmp/genesis-${Date.now()}.txt`;
    await Bun.write(tmpFile, content);
    try {
        return await callback(tmpFile);
    } finally {
        try { await Bun.file(tmpFile).unlink(); } catch {}
    }
}
```

### Pattern 3: JSON Output from AppleScript

Instead of parsing AppleScript records, build JSON strings in AppleScript:

```applescript
tell application "Mail"
    set jsonArray to "["
    set isFirst to true

    repeat with msg in (messages of inbox)
        if not isFirst then set jsonArray to jsonArray & ","
        set isFirst to false

        set msgSubject to subject of msg
        -- Escape quotes in subject
        set AppleScript's text item delimiters to "\""
        set subjectParts to text items of msgSubject
        set AppleScript's text item delimiters to "\\\""
        set escapedSubject to subjectParts as string
        set AppleScript's text item delimiters to ""

        set jsonArray to jsonArray & "{\"subject\":\"" & escapedSubject & "\"}"
    end repeat

    set jsonArray to jsonArray & "]"
    return jsonArray
end tell
```

### Pattern 4: SQLite Direct Access for Messages

```typescript
const DB_PATH = `${process.env.HOME}/Library/Messages/chat.db`;

// Core Data timestamp: nanoseconds since 2001-01-01
const CORE_DATA_EPOCH = "strftime('%s', '2001-01-01')";

function messageDateSQL(column: string): string {
    return `datetime(${column}/1000000000 + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime')`;
}
```

### Pattern 5: Permission Check with Caching

```typescript
const accessCache = new Map<string, { hasAccess: boolean; checkedAt: number }>();
const CACHE_TTL = 60_000; // 1 minute

async function checkAccess(appName: string): Promise<boolean> {
    const cached = accessCache.get(appName);
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL) {
        return cached.hasAccess;
    }

    const hasAccess = await runAppleScript(`
        tell application "${appName}"
            return name
        end tell
    `).then(() => true).catch(() => false);

    accessCache.set(appName, { hasAccess, checkedAt: Date.now() });
    return hasAccess;
}
```

---

## Appendix: AppleScript Quick Reference for Mail.app

Based on what apple-mcp uses and what we know works:

### Reading Mailboxes

```applescript
-- Get all mailbox names (REAL, not hardcoded)
tell application "Mail"
    set boxNames to {}
    repeat with mb in mailboxes
        set end of boxNames to name of mb
    end repeat
    return boxNames
end tell
```

### Reading Accounts

```applescript
-- Get all account names (REAL)
tell application "Mail"
    set acctNames to {}
    repeat with acct in accounts
        set end of acctNames to name of acct
    end repeat
    return acctNames
end tell
```

### Filtering Messages with `whose`

```applescript
-- Much faster than iterating: use whose clause
tell application "Mail"
    set inbox to mailbox "INBOX"
    set unread to (messages of inbox whose read status is false)
    return count of unread
end tell
```

### Getting Message Properties

```applescript
tell application "Mail"
    set msg to message 1 of inbox
    set subj to subject of msg
    set sndr to sender of msg
    set dt to date sent of msg
    set cont to content of msg       -- plain text body
    set src to source of msg         -- raw MIME source
    set allHeaders to all headers of msg  -- full headers
end tell
```

### Proper Mail Search (by sender)

```applescript
tell application "Mail"
    set inbox to mailbox "INBOX"
    set matches to (messages of inbox whose sender contains "john@example.com")
    return count of matches
end tell
```

---

## Appendix: Key Gotchas Discovered

1. **AppleScript `contains` is case-insensitive** on macOS for string comparisons.
   No need to lowercase in AppleScript; but the TypeScript side lowercases anyway.

2. **`messages of mailbox` loads ALL messages** into memory. For large mailboxes this
   is extremely slow. Use `whose` clauses to filter server-side.

3. **`content of message` can fail** for messages without a plain-text body (HTML-only
   or attachments-only). Always wrap in `try/on error`.

4. **Calendar.app `date` parsing** is locale-sensitive. Use explicit format:
   `date "1/15/2026 2:30 PM"` may fail on European locales. Better to construct dates
   programmatically.

5. **Notes.app uses `plaintext` not `content`** for the text body. `body` is HTML.
   `name` is the note title (first line).

6. **Reminders queries are genuinely slow** in AppleScript. For large reminder lists,
   consider using EventKit framework via JXA or Swift bridge.

7. **Maps.app has minimal scripting support**. The `maps://` URL scheme is more reliable
   than the AppleScript dictionary for most operations.

8. **Messages.app AppleScript** cannot read message history. SQLite is the only way.
   Requires Full Disk Access permission for the running terminal/app.

9. **`run-applescript` library** shells out to `osascript`. Each call spawns a new
   process. For batch operations, combine multiple operations into a single script
   to avoid process spawning overhead.

10. **AppleScript record serialization** is not JSON. `{name:"foo", id:123}` becomes
    the string `name:foo, id:123` which is ambiguous to parse. Use delimiter-based
    or JSON-string approaches instead.

11. **JXA (`@jxa/run`) runs in a separate process** with no access to Node/Bun globals.
    Arguments must be serializable. The callback function is serialized and executed in
    the JXA context, not the Node context.

12. **The `delay()` function in JXA** pauses the JXA process, not the Node process.
    It is used in Maps module to wait for search results, but the exact timing is
    unpredictable and may not be sufficient on slower machines.
