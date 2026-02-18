# Refactor `macos-mail` → `macos` Umbrella Tool

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename `src/macos-mail/` to `src/macos/` and restructure it as an umbrella tool where `mail` is one subcommand (`tools macos mail search ...`), so future subcommands (`calendar`, `contacts`) can slot in alongside it.

**Architecture:** The `tools` runner discovers tools by `src/<dir>/index.ts`. Renaming to `src/macos/` registers the umbrella. `src/macos/index.ts` creates a Commander program and adds a `mail` subcommand via `registerMailCommand()`. The mail subcommand's three commands (search, list, download) move to `src/macos/commands/mail/`. All library files move to `src/macos/lib/mail/`. Internal import paths (`@app/macos-mail/` → `@app/macos/`) update throughout.

**Tech Stack:** TypeScript, Bun, Commander.js — no new dependencies.

**Command change:**
```
# Before
tools macos-mail search <query>
tools macos-mail list [mailbox]
tools macos-mail download <output-dir>

# After
tools macos mail search <query>
tools macos mail list [mailbox]
tools macos mail download <output-dir>
```

---

## Target File Structure

```
src/macos/
  index.ts                          ← umbrella entry point (new)
  commands/
    mail/
      index.ts                      ← registerMailCommand() (new)
      search.ts                     ← moved + import paths updated
      list.ts                       ← moved + import paths updated
      download.ts                   ← moved + import paths updated
  lib/
    mail/
      types.ts                      ← moved
      constants.ts                  ← moved
      sqlite.ts                     ← moved + import paths updated
      jxa.ts                        ← moved + import paths updated
      transform.ts                  ← moved + import paths updated
      format.ts                     ← moved + import paths updated
```

---

## Task 1: Create the new directory skeleton

**Step 1: Create directories**

```bash
mkdir -p src/macos/commands/mail
mkdir -p src/macos/lib/mail
```

**Step 2: Verify**

```bash
ls src/macos/commands/mail src/macos/lib/mail
# Expected: both exist and are empty
```

---

## Task 2: Move and update lib files

All six lib files move from `src/macos-mail/lib/` → `src/macos/lib/mail/`.
Four of them import from `@app/macos-mail/...` and need those paths updated to `@app/macos/...`.

**Step 1: Copy the two pure files (no internal imports to update)**

```bash
cp src/macos-mail/lib/types.ts src/macos/lib/mail/types.ts
cp src/macos-mail/lib/constants.ts src/macos/lib/mail/constants.ts
```

**Step 2: Write `src/macos/lib/mail/transform.ts`** (1 import path changes)

```typescript
// src/macos/lib/mail/transform.ts
import { parseMailboxUrl, normalizeMailboxName } from "@app/macos/lib/mail/constants";
import type { MailMessage, MailMessageRow } from "@app/macos/lib/mail/types";

/**
 * Convert a raw SQLite row to a MailMessage domain object.
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

**Step 3: Write `src/macos/lib/mail/jxa.ts`** (1 import path changes)

```typescript
// src/macos/lib/mail/jxa.ts
import logger from "@app/logger";

interface JxaResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

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

function escapeJxa(s: string): string {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r");
}

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
                        try { content = msgs[0].content(); } catch(e) { content = "[Could not retrieve body]"; }
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
        var saved = false;
        var accounts = Mail.accounts();
        for (var a = 0; a < accounts.length && !saved; a++) {
            var mailboxes = accounts[a].mailboxes();
            for (var b = 0; b < mailboxes.length && !saved; b++) {
                try {
                    var msgs = mailboxes[b].messages.whose({
                        subject: { _equals: "${escapedSubject}" },
                        sender: { _contains: "${escapedSender}" }
                    })();
                    for (var m = 0; m < msgs.length && !saved; m++) {
                        try {
                            var atts = msgs[m].mailAttachments();
                            for (var at = 0; at < atts.length && !saved; at++) {
                                if (atts[at].name() === "${escapedAttName}") {
                                    atts[at].save({ in: Path("${escapedPath}") });
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
            return (JSON.parse(result.stdout) as { saved: boolean }).saved;
        }
    } catch (err) {
        logger.warn(`Failed to save attachment: ${err}`);
    }
    return false;
}
```

**Step 4: Write `src/macos/lib/mail/sqlite.ts`** (3 import paths change)

```typescript
// src/macos/lib/mail/sqlite.ts
import { Database } from "bun:sqlite";
import { existsSync, copyFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import logger from "@app/logger";
import { ENVELOPE_INDEX_PATH, TEMP_DB_PREFIX } from "@app/macos/lib/mail/constants";
import type {
    MailMessageRow,
    MailAttachment,
    MailRecipient,
    ReceiverInfo,
    SearchOptions,
} from "@app/macos/lib/mail/types";
```

> **Note:** Only the first 8 import lines change. Copy the rest of the file verbatim from `src/macos-mail/lib/sqlite.ts` (all the function bodies — `getDatabase`, `cleanup`, `searchMessages`, `listMessages`, `getAttachments`, `getRecipients`, `listReceivers`, `listMailboxes`, `getMessageCount` — are identical).

**Step 5: Write `src/macos/lib/mail/format.ts`** (2 import paths change)

```typescript
// src/macos/lib/mail/format.ts
import { formatTable } from "@app/utils/table";
import { formatRelativeTime, formatBytes } from "@app/utils/format";
import type { MailMessage } from "@app/macos/lib/mail/types";
import chalk from "chalk";
```

> **Note:** Only the import lines change. Copy all function bodies verbatim from `src/macos-mail/lib/format.ts`.

**Step 6: Commit**

```bash
git add src/macos/lib/
git commit -m "feat(macos): move macos-mail lib → src/macos/lib/mail/ with updated import paths"
```

---

## Task 3: Move and update command files

**Step 1: Write `src/macos/commands/mail/list.ts`** (all `@app/macos-mail/` → `@app/macos/`)

```typescript
// src/macos/commands/mail/list.ts
import * as p from "@clack/prompts";
import type { Command } from "commander";
import {
    listMessages,
    getAttachments,
    cleanup,
} from "@app/macos/lib/mail/sqlite";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage } from "@app/macos/lib/mail/types";
```

> **Note:** Only the import paths change. Copy the `registerListCommand` function body verbatim from `src/macos-mail/commands/list.ts`.

**Step 2: Write `src/macos/commands/mail/download.ts`** (all `@app/macos-mail/` → `@app/macos/`)

Also update the temp file path constant (one line):

```typescript
// src/macos/commands/mail/download.ts
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import logger from "@app/logger";
import { getRecipients, cleanup } from "@app/macos/lib/mail/sqlite";
import { getMessageBody, saveAttachment } from "@app/macos/lib/mail/jxa";
import {
    generateEmailMarkdown,
    generateIndexMarkdown,
    generateSlug,
} from "@app/macos/lib/mail/format";
import type { MailMessage } from "@app/macos/lib/mail/types";

// Updated temp path
const LAST_SEARCH_PATH = "/tmp/macos-mail-last-search.json";

function loadLastSearchResults(): MailMessage[] | null {
    if (!existsSync(LAST_SEARCH_PATH)) return null;
    // ... rest identical
}
```

> **Note:** Import paths and the `LAST_SEARCH_PATH` constant update. Everything else is verbatim from `src/macos-mail/commands/download.ts`.

**Step 3: Write `src/macos/commands/mail/search.ts`** (all `@app/macos-mail/` → `@app/macos/`)

Also update the temp file write path (one line at the end):

```typescript
// src/macos/commands/mail/search.ts
import * as p from "@clack/prompts";
import type { Command } from "commander";
import logger from "@app/logger";
import {
    searchMessages,
    getAttachments,
    listReceivers,
    cleanup,
    getMessageCount,
} from "@app/macos/lib/mail/sqlite";
import { searchBodies } from "@app/macos/lib/mail/jxa";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage, SearchOptions } from "@app/macos/lib/mail/types";
```

Near the bottom of the action handler, update the temp path write (same constant):
```typescript
// Replace:
await Bun.write("/tmp/macos-mail-last-search.json", tempResults);
// With:
await Bun.write("/tmp/macos-mail-last-search.json", tempResults); // path unchanged — download reads this
```

> **Note:** Keep the temp path the same string `/tmp/macos-mail-last-search.json` so download still finds it. Only import paths change.

**Step 4: Commit**

```bash
git add src/macos/commands/mail/
git commit -m "feat(macos): move macos-mail commands → src/macos/commands/mail/ with updated import paths"
```

---

## Task 4: Create the `mail` subcommand index

**Files:**
- Create: `src/macos/commands/mail/index.ts`

**Step 1: Write the file**

```typescript
// src/macos/commands/mail/index.ts

import { Command } from "commander";
import { registerSearchCommand } from "./search";
import { registerListCommand } from "./list";
import { registerDownloadCommand } from "./download";

/**
 * Register the `mail` subcommand on the parent program.
 * Usage: tools macos mail <search|list|download> [options]
 */
export function registerMailCommand(program: Command): void {
    const mail = new Command("mail");
    mail
        .description("Search, list, and download emails from macOS Mail.app")
        .showHelpAfterError(true);

    registerSearchCommand(mail);
    registerListCommand(mail);
    registerDownloadCommand(mail);

    program.addCommand(mail);
}
```

**Step 2: Commit**

```bash
git add src/macos/commands/mail/index.ts
git commit -m "feat(macos): add mail subcommand index (registerMailCommand)"
```

---

## Task 5: Create the `macos` umbrella entry point

**Files:**
- Create: `src/macos/index.ts`

**Step 1: Write the file**

```typescript
#!/usr/bin/env bun

/**
 * macOS Native Tools
 *
 * Umbrella tool for interacting with macOS native frameworks.
 *
 * Usage:
 *   tools macos mail search <query> [options]
 *   tools macos mail list [mailbox] [options]
 *   tools macos mail download <output-dir> [options]
 *
 * Future subcommands:
 *   tools macos calendar events
 *   tools macos contacts search
 */

import { handleReadmeFlag } from "@app/utils/readme";
import logger from "@app/logger";
import { Command } from "commander";

handleReadmeFlag(import.meta.url);

import { registerMailCommand } from "@app/macos/commands/mail/index";

const program = new Command();

program
    .name("macos")
    .description("Interact with macOS native frameworks (Mail, Calendar, Contacts, ...)")
    .version("1.0.0")
    .showHelpAfterError(true);

registerMailCommand(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);

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

**Step 2: Commit**

```bash
git add src/macos/index.ts
git commit -m "feat(macos): add umbrella macos tool entry point"
```

---

## Task 6: Delete the old `src/macos-mail/` directory

**Step 1: Verify the new tool works first**

```bash
bun run src/macos/index.ts --help
# Expected:
# Usage: macos [options] [command]
# Interact with macOS native frameworks (Mail, Calendar, Contacts, ...)
# Commands:
#   mail   Search, list, and download emails from macOS Mail.app

bun run src/macos/index.ts mail --help
# Expected:
# Usage: macos mail [options] [command]
# Commands:
#   search <query>
#   list [mailbox]
#   download <output-dir>

bun run src/macos/index.ts mail list --limit 5
# Expected: lists 5 recent emails from INBOX
```

**Step 2: Remove old directory**

```bash
rm -rf src/macos-mail/
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(macos): remove src/macos-mail (superseded by src/macos)"
```

---

## Task 7: Verify end-to-end

**Step 1: Run a search**

```bash
tools macos mail search "invoice" --without-body --limit 10
# Expected: table of results (or "no messages found")
```

**Step 2: Verify old command is gone**

```bash
tools macos-mail search "test" 2>&1
# Expected: "Unknown tool: macos-mail" or similar error
```

**Step 3: Verify help output is correct**

```bash
tools macos --help
tools macos mail --help
tools macos mail search --help
```

**Step 4: Final commit if anything was adjusted**

```bash
git add -A
git commit -m "chore(macos): post-refactor cleanup"
```

---

## Notes for Future Subcommands

After this refactor, adding `calendar` or `contacts` is just:

1. Create `src/macos/commands/calendar/index.ts` with `registerCalendarCommand()`
2. Create `src/macos/lib/calendar/` for any calendar-specific lib files
3. In `src/macos/index.ts`, add:
   ```typescript
   import { registerCalendarCommand } from "@app/macos/commands/calendar/index";
   registerCalendarCommand(program);
   ```

This gives: `tools macos calendar events --today`
