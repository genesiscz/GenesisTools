# macos-automator-mcp -- Comprehensive Exploration Document

> Repository: [steipete/macos-automator-mcp](https://github.com/steipete/macos-automator-mcp)
> Version: 0.4.1 | License: MIT | Author: steipete
> Explored: 2026-02-16

---

## Table of Contents

1. [Repository Overview](#1-repository-overview)
2. [Architecture Deep Dive](#2-architecture-deep-dive)
3. [MCP Tool Definitions](#3-mcp-tool-definitions)
4. [Knowledge Base Structure](#4-knowledge-base-structure)
5. [Complete Script Catalog by Category](#5-complete-script-catalog-by-category)
6. [Mail.app Scripts -- Detailed Section](#6-mailapp-scripts----detailed-section)
7. [Templating and Argument Substitution System](#7-templating-and-argument-substitution-system)
8. [AppleScript vs JXA Support](#8-applescript-vs-jxa-support)
9. [Error Handling Patterns](#9-error-handling-patterns)
10. [Shared Handlers](#10-shared-handlers)
11. [AI Script Selection Mechanism](#11-ai-script-selection-mechanism)
12. [Reusable Patterns and Scripts for Our Tool](#12-reusable-patterns-and-scripts-for-our-tool)
13. [Comparison with apple-mcp Approach](#13-comparison-with-apple-mcp-approach)
14. [Key Takeaways](#14-key-takeaways)

---

## 1. Repository Overview

### What It Is

`macos-automator-mcp` is an MCP (Model Context Protocol) server that gives AI assistants the
ability to execute AppleScript and JXA (JavaScript for Automation) scripts on macOS. It ships
with a knowledge base of ~500 pre-built automation scripts organized into 13 categories, covering
everything from Finder file operations to Safari browser control to Mail.app email automation.

### Repository Structure

```
macos-automator-mcp/
  src/
    server.ts                        # MCP server entrypoint (registers tools, connects transport)
    ScriptExecutor.ts                # Executes osascript with timeout, output formatting
    placeholderSubstitutor.ts        # Replaces --MCP_INPUT:key and --MCP_ARG_N in KB scripts
    schemas.ts                       # Zod schemas for execute_script and get_scripting_tips
    types.ts                         # TypeScript interfaces
    logger.ts                        # Simple logger (DEBUG/INFO/WARN/ERROR, writes to stderr)
    services/
      KnowledgeBaseManager.ts        # Loads embedded + local KB, merges, caches
      kbLoader.ts                    # Parses .md tip files (gray-matter frontmatter + code blocks)
      knowledgeBaseService.ts        # Search (Fuse.js), format results as Markdown
      scriptingKnowledge.types.ts    # ScriptingTip, SharedHandler, KnowledgeBaseIndex interfaces
  knowledge_base/                    # ~500 markdown scripts organized in 13+ categories
    01_intro/                        # Meta docs (how to use the KB)
    02_as_core/                      # AppleScript language reference
    03_jxa_core/                     # JXA language reference + app automation
    04_system/                       # System settings, audio, display, notifications
    05_files/                        # File/folder operations via Finder and shell
    06_terminal/                     # Terminal.app, iTerm, Ghostty automation
    07_browsers/                     # Safari, Chrome, Firefox automation
    08_editors/                      # VS Code, Cursor, JetBrains, Sublime Text
    09_productivity/                 # Calendar, Mail, Contacts, Notes, Reminders, Messages
    10_creative/                     # Music, Photos, Keynote, Pages, Numbers, Spotify, VLC
    11_advanced/                     # Performance tips, inter-app communication
    12_network/                      # WiFi, port management, FTP
    13_developer/                    # Xcode, iOS Simulator, Docker, Git, Shortcuts, Things
    _shared_handlers/                # Reusable AppleScript handler files
  scripts/                           # Validation, reporting, and fix scripts
  tests/                             # E2E tests via vitest
  docs/                              # Development docs, AppleScript references
  start.sh                           # Launcher (compiled dist/ or tsx src/)
  package.json
  tsconfig.json
```

### Dependencies

| Dependency | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` ^1.25.1 | MCP server SDK (stdio transport) |
| `fuse.js` ^7.1.0 | Fuzzy search across the knowledge base |
| `gray-matter` ^4.0.3 | Parse YAML frontmatter from markdown tip files |
| `zod` ^4.2.1 | Input validation schemas for MCP tools |

Dev dependencies include TypeScript 5.9, tsx (for running TS directly), eslint, prettier, vitest.

### Runtime Requirements

- Node.js >= 18.0.0 (runs on Node, NOT Bun)
- macOS only (uses `osascript` binary)
- System Settings permissions: Automation + Accessibility
- Package manager: pnpm (declared in packageManager field)

---

## 2. Architecture Deep Dive

### Execution Flow

```
AI Client (Claude, etc.)
    |
    v
MCP Protocol (stdio)
    |
    v
server.ts -- McpServer with 2 registered tools
    |
    +-- execute_script tool
    |     |
    |     +-- kb_script_id path:
    |     |     KnowledgeBaseManager.getKnowledgeBase() -> find tip by ID
    |     |     placeholderSubstitutor.substitutePlaceholders() -> replace --MCP_INPUT, --MCP_ARG
    |     |     ScriptExecutor.execute() -> osascript
    |     |
    |     +-- script_content path:
    |     |     ScriptExecutor.execute() -> osascript -e "..."
    |     |
    |     +-- script_path path:
    |           ScriptExecutor.execute() -> osascript /path/to/script.scpt
    |
    +-- get_scripting_tips tool
          |
          KnowledgeBaseManager.getKnowledgeBase()
          knowledgeBaseService.getScriptingTipsService()
          Fuse.js fuzzy search -> format as Markdown
```

### Key Design Decisions

1. **Lazy KB loading by default** -- The knowledge base is loaded on first use (`KB_PARSING=lazy`).
   Setting `KB_PARSING=eager` loads everything at startup.

2. **Two-layer KB** -- An embedded KB ships with the npm package. Users can overlay a local KB
   at `~/.macos-automator/knowledge_base` (or `LOCAL_KB_PATH` env). Local scripts override
   embedded scripts with matching IDs.

3. **Script-per-markdown** -- Each automation script is a standalone markdown file with YAML
   frontmatter (metadata) and a fenced code block (the script itself).

4. **osascript as execution engine** -- All scripts run via `osascript` with language flags
   (`-l JavaScript` for JXA). No Node native bindings to Apple events.

5. **Placeholder substitution over arguments** -- Rather than passing args via `on run argv`,
   KB scripts use placeholder markers (`--MCP_INPUT:key`, `--MCP_ARG_N`) that get string-replaced
   before execution.

### ScriptExecutor Implementation

The `ScriptExecutor` class is straightforward:

```typescript
// Simplified from src/ScriptExecutor.ts
export class ScriptExecutor {
  async execute(
    scriptSource: { content?: string; path?: string },
    options: ScriptExecutionOptions
  ): Promise<ScriptExecutionResult> {
    // Platform check (macOS only)
    if (os.platform() !== 'darwin') throw UnsupportedPlatformError;

    const osaArgs: string[] = [];

    // Language selection
    if (language === 'javascript') osaArgs.push('-l', 'JavaScript');

    // Output format flags
    switch (resolved_mode) {
      case 'human_readable':    osaArgs.push('-s', 'h'); break;
      case 'structured_error':  osaArgs.push('-s', 's'); break;
      case 'direct':            /* no flags */ break;
    }

    // Script source
    if (scriptSource.content) osaArgs.push('-e', scriptSource.content);
    else if (scriptSource.path) osaArgs.push(scriptSource.path);

    // Execute with timeout
    const { stdout, stderr } = await execFileAsync('osascript', osaArgs, {
      timeout: timeoutMs
    });

    return { stdout: stdout.trim(), stderr: stderr.trim(), execution_time_seconds };
  }
}
```

Key points:
- Uses Node's `child_process.execFile` (not `exec`) for security
- Timeout kills the process (sets `isTimeout` flag)
- Returns execution time for optional reporting
- Output format modes: `auto`, `human_readable`, `structured_error`, `structured_output_and_error`, `direct`

---

## 3. MCP Tool Definitions

### Tool 1: `execute_script`

The primary tool for running AppleScript/JXA on macOS.

**Input Parameters (Zod schema):**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kb_script_id` | string | One of three | ID of a knowledge base script |
| `script_content` | string | One of three | Raw inline script code |
| `script_path` | string | One of three | Absolute POSIX path to script file |
| `arguments` | string[] | No | Positional args (for script_path or --MCP_ARG_N) |
| `input_data` | object | No | Named inputs for --MCP_INPUT:key placeholders |
| `language` | 'applescript' \| 'javascript' | No | Defaults to applescript; inferred for kb_script_id |
| `timeout_seconds` | number | No | Default 60 |
| `output_format_mode` | enum | No | Default 'auto' |
| `report_execution_time` | boolean | No | Default false |
| `include_executed_script_in_output` | boolean | No | Default false |
| `include_substitution_logs` | boolean | No | Default false |

**Mutual exclusivity:** Exactly one of `kb_script_id`, `script_content`, or `script_path` must
be provided (enforced by Zod `.refine()`).

**Response format:**
```typescript
{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;  // true when stdout starts with "Error"
}
```

### Tool 2: `get_scripting_tips`

Discovery tool for browsing and searching the knowledge base.

**Input Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `list_categories` | boolean | false | Returns category tree with descriptions |
| `category` | string | - | Filter tips by category ID |
| `search_term` | string | - | Fuzzy search across titles, descriptions, keywords, scripts |
| `refresh_database` | boolean | false | Force-reload KB from disk |
| `limit` | number | 10 | Max results returned |

**Search behavior:**
- Primary search at threshold 0.4 (Fuse.js)
- Falls back to broader search at threshold 0.7 if no results
- Search keys weighted: title (0.4), id (0.3), keywords (0.2), description (0.1), script (0.05)
- Results formatted as Markdown with script content, runnable ID, argument prompts

### Tool 3: `accessibility_query`

Uses a bundled `ax` binary for macOS accessibility API queries. Allows:
- Querying UI elements by role, attributes, navigation path
- Performing actions (AXPress, etc.) on matched elements
- Multiple output formats: smart, verbose, text_content

This tool is documented in README but the `ax` binary is not in the source tree (likely compiled
separately or downloaded at runtime).

---

## 4. Knowledge Base Structure

### File Format

Each script/tip is a markdown file with YAML frontmatter:

```markdown
---
title: 'Mail: Get Unread Message Count'
category: 09_productivity
id: mail_get_unread_count
description: >-
  Retrieves the unread message count from specified mailboxes
keywords:
  - Mail
  - email
  - unread
  - count
language: applescript
isComplex: false
argumentsPrompt: >-
  Provide a mailbox name as 'mailboxName' in inputData (optional)
notes: |
  - Returns unread counts for the specified mailbox
  - Requires Automation permission for Mail.app
---

(Optional prose description here)

```applescript
-- The actual script code
tell application "Mail"
  -- ...
end tell
`` `
```

### Frontmatter Fields (TipFrontmatter interface)

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Human-readable title |
| `id` | string | No | Unique script ID (auto-generated from path if missing) |
| `category` | string | No | Category ID (inferred from directory) |
| `description` | string | No | Brief description |
| `keywords` | string[] | No | Search keywords |
| `language` | 'applescript' \| 'javascript' | No | Inferred from code block |
| `isComplex` | boolean | No | Heuristic: script > 250 chars = complex |
| `argumentsPrompt` | string | No | Human-readable description of expected inputs |
| `notes` | string | No | Additional usage notes |

### Category Info Files

Each category directory contains a `_category_info.md` with frontmatter:

```yaml
---
title: "Productivity Apps"
description: "Scripts for automating macOS productivity applications"
category: "09_productivity"
---
```

### ID Generation Rules

If no `id` is specified in frontmatter, the ID is generated as:
`{categoryId}_{pathPrefix}{baseName}`

Where:
- `categoryId` = directory name (e.g., `09_productivity`)
- `pathPrefix` = relative subdirectory path with `/` replaced by `_`
- `baseName` = filename without extension, leading numbers stripped, spaces to underscores

Example: `knowledge_base/09_productivity/mail_app/mail_get_unread_count.md`
generates ID = `09_productivity_mail_app_mail_get_unread_count` (unless overridden).

### Script Extraction

The loader (`kbLoader.ts`) uses regex to extract code blocks:

```typescript
const asMatch = markdownBody.match(/```applescript\s*\n([\s\S]*?)\n```/i);
const jsMatch = markdownBody.match(/```javascript\s*\n([\s\S]*?)\n```/i);
```

Only the FIRST matching code block of either type is used. The language is determined by which
regex matches.

---

## 5. Complete Script Catalog by Category

### Statistics

| Category | Script Count | Description |
|---|---|---|
| 01_intro | 2 | Meta docs: how to use the KB, dictionary viewer |
| 02_as_core | 50 | AppleScript language reference (operators, types, handlers, OSAX) |
| 03_jxa_core | 49 | JXA reference (syntax, file ops, clipboard, UI automation, browser) |
| 04_system | 26 | System settings, audio, display, notifications, screen lock, power |
| 05_files | 22 | File/folder operations, batch ops, backup, encryption |
| 06_terminal | 31 | Terminal.app, iTerm, Ghostty automation |
| 07_browsers | 72 | Safari (30), Chrome (22), Firefox (15), common JS snippets (5) |
| 08_editors | 18 | VS Code, Cursor, JetBrains, Sublime Text, Electron editors |
| 09_productivity | 63 | Calendar, Mail, Contacts, Notes, Reminders, Messages, Maps, etc. |
| 10_creative | 61 | Music, Photos, Keynote, Pages, Numbers, Spotify, VLC, etc. |
| 11_advanced | 7 | Performance, inter-app communication, Pomodoro timer |
| 12_network | 5 | WiFi management, port scanning, FTP, sharing services |
| 13_developer | 92 | Xcode (42), iOS Simulator, Docker, Git, Shortcuts, Things, etc. |
| **Total** | **~498** | |

### Category 01_intro -- Introduction

- `conventions_how_to_use_kb` -- How to query and use the KB
- `meta_open_dictionary` -- Open scripting dictionary for any app

### Category 02_as_core -- AppleScript Core

**Operators:** arithmetic, coercion, comparison, concatenation, contains, logical, reference, string prefix/suffix

**Reference Forms:** arbitrary, filter/whose, id, index, name, property, range, relative

**Scripting Additions (OSAX):** beep, choose (application, color, file, from list, URL), current date, delay, display dialog, do shell script, file read/write, info for, list disk/folder, load script, path to, round, run script, the clipboard, time to GMT, offset of

**Variables/Data Types:** alias, boolean, constant, data (raw), date, integer, list, record, string

**Handlers:** on idle, on open (droplet), on quit, on reopen, tell application block

### Category 03_jxa_core -- JavaScript for Automation Core

**Browser automation:** Chrome operations, Safari operations, Safari content extraction, multi-browser tab management

**Clipboard:** files, images, manager, rich text, text operations

**File operations:** basic, paths/aliases, folder ops, unicode

**JSON processing:** base, convert format, fetch API, merge, process file, save file, transform data

**System Events:** application menu control, keystrokes, system functions, UI elements control

**UI Automation:** base, click, drag & drop, element values, find element, hierarchy, menu actions, scroll, wait for element, window info

**Other:** introduction/syntax, display dialog, notifications, do shell script, file dialogs, Finder interaction, ObjC bridge, system appearance

### Category 04_system -- System Control

**Audio:** app-specific volume, switch audio output, system volume control

**Clipboard:** history manager, get file paths from clipboard

**Display:** brightness control

**Notifications:** notification center

**Power:** sleep/wake control

**Screen:** lock screen, Screen Time (app limits, get usage)

**System Info:** information retrieval

**Settings:** appearance/dark mode, date/time/timezone, memory/mouse concepts, network location switching, sound input/output selection, Wi-Fi toggle, notifications, open settings pane

**Window Management:** window arrangement

### Category 05_files -- File System Operations

**Backup:** system backup core, engine, scheduler, backup script

**Batch:** apply metadata, convert images, move/organize, rename, folder cleanup

**Finder Operations:** batch rename, create folder, get selected items, list desktop, organize by type

**File I/O (no Finder):** read text file, write text file

**Folder:** create new folder on desktop

**Paths:** standard folders, POSIX vs HFS, user file/folder selection

**Security:** file encryption/decryption

### Category 06_terminal -- Terminal Automation

**Terminal.app:** find/focus window, kill process by port, get tab content, manage titles, open/close window, run command + get output, send control character, session management, split pane, window arrangement

**iTerm:** dev environment, dynamic profiles, manage titles, send text, session management, split pane, tmux integration, window arrangement

**Ghostty:** automation, manage titles, send text

**File Operations:** change permissions, compress, copy, create, delete, extract archive, move

**Coordination:** broadcast mode, echo mode, parallel mode

### Category 07_browsers -- Browser Automation (72 scripts)

**Safari (30 scripts):** get URL, list tabs, open URL, close tab, reload, switch tab, execute JS, get DOM info, inject script, capture screenshot, clear cache, export PDF, form filler, form manipulation, bookmarks, inspect element, local storage, modify DOM, network monitor, open Web Inspector, performance analysis, privacy features, responsive design mode, save bookmark, save page, security testing, event listener

**Chrome (22 scripts):** get URL, list tabs, open URL, close tab, execute JS (3 variants), capture screenshot, bookmarks, clear data, CORS disable, CSS selector finder, emulate device, form filler, geolocation spoofing, inspect element, intercept network, network throttling, open DevTools, record performance trace, test runner, accessibility inspector

**Firefox (15 scripts):** get URL, list tabs, open URL, close tab, refresh, execute JS, capture screenshot, save as PDF, bookmark page, developer tools, network throttling, responsive design, switch tab by title, toggle private browsing

**Common JS Snippets (5):** click element, extract all links, get element by ID, get page ready state, get/set input value

### Category 08_editors -- Code Editors

**Electron Editors:** DevTools JS inject, get content via clipboard, open file/folder, VS Code get editor content

**VS Code:** open folder, run command, settings sync

**Cursor:** AI commands

**JetBrains:** open project, run action

**Sublime Text:** get content, manipulate text, open file/folder, package management, project management, run command

**Browser DevTools:** capture network HAR

**Common IDE Patterns:** command palette

### Category 09_productivity -- Productivity Apps (63 scripts)

**Mail.app (28 scripts):** See [detailed section below](#6-mailapp-scripts----detailed-section)

**Calendar (4):** create event, event creator, find events, list today's events

**Contacts (5):** create group, create contact, export vCard, list all, search by name

**FaceTime (4):** create link, live captions, record call, start call

**Find My (3):** device location, list devices, track items

**Home (3):** control device, list devices, manage automations

**Maps (2):** get current location, search location

**Messages (6):** create group chat, get chat history, get recent chats, send file, send message, set status

**Notes (3):** create folder, create plain text note, search notes

**Reminders (5):** create list, create reminder (2 variants), create complex reminder, list due today

### Category 10_creative -- Creative Apps (61 scripts)

**Music (6):** current track info, library management, playback controls, playlist operations, repeat/shuffle control, search and play

**Spotify (9):** current track info, keyboard control, playback controls, playback position, playlist ops, repeat/shuffle, save track, search and play, URI handler

**VLC (3):** current media info, open media, playback controls

**Photos (4):** create album, export photos, get selected items, slideshow

**Keynote (6):** add slide, create presentation, export, presenter notes, set slide text, slideshow control

**Pages (6):** create document, document analysis, export PDF, manage styles, table operations, template operations

**Numbers (4):** create chart, create spreadsheet, edit cell/formula, export CSV

**GarageBand (3):** basic controls, project management, smart controls

**Logic Pro (3):** basic controls, project management, scripter MIDI

**Books (2):** get current book, open book

**Image Events (4):** audio conversion, image conversion, get dimensions, video conversion

**TextEdit (1):** get/set text

**TV (2):** get current playback, play movie

**QuickTime (2):** open video, record screen

**Podcasts (2):** list subscriptions, play episode

**Voice Memos (2):** list recordings, record new

**Preview (2):** export PDF as image, open file

### Category 11_advanced -- Advanced Topics

- Large data and performance handling
- Raw Apple Events
- Using terms from application
- Ignoring application responses
- Considering/ignoring attributes
- Pomodoro focus timer
- Pomodoro timer

### Category 12_network -- Network Operations

- FTP operations via URL access
- networksetup CLI basics
- Sharing services status
- Find/kill process by port
- WiFi management

### Category 13_developer -- Developer Tools (92 scripts)

**Xcode/iOS Simulator (42):** list devices, boot device, install app, launch arguments, open URL, send notification, set location, shake gesture, status bar (2), toggle appearance, touch indicators, record video, screenshots, biometric auth (2), privacy permissions, clone device, create device, change language, add photos, pasteboard, developer settings, keyboard settings, iCloud sync, monitor logs, accessibility (2), performance report, reset app data, rotate device. Plus Xcode proper: archive, build (shell + UI), clean derived data, clean project, extract project info (2 variants), launch simulator, open Instruments, open project, reset all simulators, run project, run UI tests, run unit tests, switch scheme.

**Things (9):** complete todo, create area, create project, create tag, create todo, get todos, project management, review automation, URL scheme

**Kaleidoscope (6):** CLI integration, compare clipboard, compare files, dev tools integration, file version tracker, view git changeset, view git history

**Script Editor (8):** compile document, compile & run, get text, open file, run document, save as app, save document, set text

**Keychain (4):** list keychains, get password, add generic password, lock/unlock keychain

**Shortcuts (3):** create folder, list all, run by name

**Docker (1):** container controller

**Git (1):** commit & push

**App Store (2):** open account, search

**Calculator (2):** perform calculation, switch view

**Dictionary (2):** look up word, switch dictionary

**Font Book (2):** list fonts, search font

**Parallels Desktop (3):** controller, VM controller, VM management

**VirtualBuddy (2):** automation, controller

**VMware Fusion (1):** controller

---

## 6. Mail.app Scripts -- Detailed Section

The Mail.app category is one of the richest in the knowledge base, with **28 scripts** split
between a main directory and an `automation/` subdirectory.

### Main Mail Scripts (17 scripts)

#### mail_send_email_direct
**Sends an email programmatically.** Creates an outgoing message with recipient, subject, body,
and optional attachment. Uses `make new outgoing message` + `make new to recipient` + `send`.

Placeholders: `recipientEmail`, `subject`, `body`, `attachmentPath`

```applescript
-- Key pattern: set via comment-style defaults, then MCP substitution
set recipientEmail to "recipient@example.com" -- --MCP_INPUT:recipientEmail
set emailSubject to "Important Information" -- --MCP_INPUT:subject
```

#### mail_get_unread_count
**Gets unread message count per account.** Iterates all accounts, finds the target mailbox
(default: INBOX), sums unread counts. Returns formatted text with per-account breakdown.

Placeholders: `mailboxName` (optional, defaults to INBOX)

Pattern: Uses AppleScript handler pattern with `on setDefaultMailbox()` + main function
`on getUnreadCount()`, invoked at bottom with `return my getUnreadCount("--MCP_INPUT:mailboxName")`.

#### mail_search_messages
**Searches emails by subject, sender, or content.** Iterates all accounts/mailboxes,
applies filter based on `searchType` (subject/sender/content), returns formatted results.
Limits to 10 results for performance.

Placeholders: `searchTerm`, `searchType`, `mailboxName`

#### mail_save_attachments
**Saves attachments from selected emails.** Works on Mail.app selection. Creates
per-email subfolders when multiple messages selected. Sanitizes filenames.

Placeholders: `savePath` (optional, defaults to Desktop)

#### mail_summarize_inbox
**Generates inbox analytics.** Counts messages by date range (today/week/month/older),
identifies top senders and active conversation threads. Analyzes up to 100 most recent
messages for performance.

Placeholders: `accountName` (optional)

#### mail_compose_new_email_mailto
**Opens a pre-filled draft via mailto URL.** Implements URL encoding in pure AppleScript.
Does NOT auto-send -- opens Mail with the draft for review.

Placeholders: `recipient`, `subject`, `body`

#### mail_list_accounts_mailboxes
**Lists all accounts and their mailboxes.** Shows message counts and unread counts
with nicely formatted output (thousands separators, alignment padding).

No placeholders (no inputs needed).

#### mail_flag_messages
**Flags selected messages with a color.** Supports all 7 Mail flag colors (red, orange,
yellow, green, blue, purple, gray) plus "none" to unflag.

Placeholders: `flagColor` (optional, defaults to red)

#### mail_move_messages
**Moves selected messages to a target mailbox.** Searches for the target mailbox in
a specific account or across all accounts. Reports success/failure count.

Placeholders: `targetMailbox`, `accountName`

#### mail_smart_reply
**Template-based smart reply system.** Reads template files from a folder, scores them
against the incoming email by analyzing keywords in subject/body and sender info. Supports
template placeholders like `--NAME--`, `--SUBJECT--`, `--QUOTED--`, `--YOUR-NAME--`.
Creates the reply in Mail with the processed template content.

Placeholders: `templatePath` (optional, defaults to ~/Documents/Templates/)

This is the most sophisticated Mail script at ~360 lines, implementing:
- Template discovery (reads .txt files from a folder)
- Keyword-based template scoring (urgent, request, question, meeting, etc.)
- Sender-based template matching
- Template variable substitution
- Default template generation

#### mail_statistics_report
**Generates a comprehensive email analytics report.** Analyzes received and sent messages
over a configurable time period. Outputs volume stats, peak activity days/hours, top
senders/recipients, domain distribution, response time analysis, and top conversation
threads. Supports plain text, markdown, and HTML output formats.

Placeholders: `daysToAnalyze` (default 30), `outputFormat` (text/markdown/html)

At ~780 lines, this is the longest single script in the Mail category.

#### mail_batch_archive
**Archives old inbox messages.** Moves messages older than N days (default 30) to an
archive folder. Preserves flagged and unread messages. Supports per-account or all-accounts
mode. Smart fallback for finding archive mailbox.

Placeholders: `daysThreshold`, `accountName`, `archiveMailbox`

#### mail_check_for_replies
**Identifies unanswered sent emails.** Scans sent folders for messages that haven't
received replies within a configurable threshold (default 3 days). Filters out auto-replies
and calendar invites. Checks inbox across all accounts for matching replies.

Placeholders: `daysThreshold` (default 3)

#### mail_create_rule
**Creates a Mail.app rule via UI scripting.** Uses System Events to navigate Mail's
Preferences > Rules panel, create a new rule with specified criteria and actions. This
is a UI automation script (fragile, depends on Mail version).

Placeholders: `ruleName`, `searchField`, `searchText`, `actionType`, `actionTarget`

#### mail_create_smart_mailbox
**Creates a Smart Mailbox via UI scripting.** Similar UI automation approach, navigating
Mail's menus to create a Smart Mailbox with specified criteria.

Placeholders: `mailboxName`, `criteriaField`, `criteriaText`

#### mail_export_contacts
**Extracts email addresses from selected messages.** Collects From, To, and CC addresses,
deduplicates, groups by domain, and exports to a text file with statistics.

Placeholders: `exportPath` (optional, defaults to Desktop)

#### mail_automation_script
Listed in the directory but similar to the automation core scripts below.

### Automation Subdirectory (11 scripts)

The `automation/` subdirectory contains a more modular mail automation system:

#### mail_automation_core
**Core initialization, logging, account management.** Provides property declarations,
`initializeMailAutomation()`, `logMessage()`, `getMailAccounts()`, `getMailSignatures()`,
`getMailFolders()`, helper functions for email parsing and text replacement. This acts as
a library/framework that other automation scripts build on.

Note: This script has MULTIPLE code blocks in the markdown (not just one), which means
only the first code block is extracted by the loader. The rest serve as documentation.

#### mail_create_quick_message
**Rapid email composition.** Creates a visible draft in Mail with recipient, subject, and
content. Supports both interactive mode (display dialog prompts) and MCP parameter mode.

#### mail_apply_template_responses
Template-based response system.

#### mail_archive_old_messages
Archive automation (overlaps with mail_batch_archive).

#### mail_create_email_digest
Creates a digest summary of recent emails.

#### mail_email_composition
Email composition with rich options.

#### mail_organize_messages
Automated message organization by rules.

#### mail_process_inbox_rules
Applies custom inbox processing rules.

#### mail_search_organization
Search and organize combined workflow.

#### mail_template_system
Template management system.

#### mail_ui_components
UI component helpers for mail automation.

### Mail Script Patterns Summary

**Common patterns across all Mail scripts:**

1. **Handler-based structure:** Scripts define named handlers (`on functionName(args)`),
   then call them at the bottom with `return my functionName("--MCP_INPUT:...")`.

2. **Default value handling:** Every input parameter has an `on setDefault*()` handler that
   checks for `missing value` or empty string and provides sensible defaults.

3. **Error handling:** Every script wraps its main logic in `try...on error errMsg` blocks
   and returns human-readable error messages prefixed with "Error:".

4. **Account iteration:** Most scripts iterate over `every account`, skip "On My Mac"
   accounts, and handle missing mailboxes gracefully.

5. **Performance limiting:** Search/analysis scripts limit results (e.g., `maxResults to 10`,
   analyze at most 100 messages) to avoid performance issues.

6. **Formatted output:** Scripts return well-formatted text with separators, bullet points,
   and aligned columns rather than raw data.

---

## 7. Templating and Argument Substitution System

The placeholder substitution system is implemented in `placeholderSubstitutor.ts` and handles
replacing template markers in KB scripts with actual values before execution.

### Placeholder Types

#### 1. Named Input Placeholders (`--MCP_INPUT:keyName`)

Used with `input_data` JSON object. The key name in the script maps to a key in `input_data`
(with camelCase to snake_case conversion).

**Forms supported:**

```
"--MCP_INPUT:keyName"        # Quoted (single or double) -- most common
'--MCP_INPUT:keyName'        # Quoted with single quotes
(--MCP_INPUT:keyName)        # In expression context (after parenthesis, comma, equals)
${inputData.keyName}         # JS-style template literal
```

**Example in script:**
```applescript
set recipientEmail to "--MCP_INPUT:recipientEmail"
```

**With input_data:** `{ "recipient_email": "user@example.com" }`

**After substitution:**
```applescript
set recipientEmail to "user@example.com"
```

#### 2. Positional Argument Placeholders (`--MCP_ARG_N`)

Used with `arguments` string array. N is 1-based.

**Forms supported:**
```
"--MCP_ARG_1"                # Quoted
'--MCP_ARG_1'                # Single-quoted
(--MCP_ARG_1)                # Expression context
${arguments[0]}              # JS-style (0-based index!)
```

#### 3. Case Conversion

The substitutor automatically converts camelCase keys in scripts to snake_case for lookup:

```typescript
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}
```

So `--MCP_INPUT:recipientEmail` looks up `recipient_email` in `input_data`.

### Value Conversion to AppleScript Literals

```typescript
function valueToAppleScriptLiteral(value: unknown): string {
    if (typeof value === 'string')  return `"${escaped}"`;   // Escaped string literal
    if (typeof value === 'number')  return String(value);     // Bare number
    if (typeof value === 'boolean') return String(value);     // true/false
    if (Array.isArray(value))       return `{${items}}`;      // AppleScript list
    if (typeof value === 'object')  return `{key:val, ...}`;  // AppleScript record
    return "missing value";                                    // Null fallback
}
```

String escaping handles backslashes and double quotes:
```typescript
function escapeForAppleScriptStringLiteral(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
```

### Substitution Order (6 regex passes)

1. **JS-style inputData:** `${inputData.keyName}` -> value
2. **JS-style arguments:** `${arguments[N]}` -> value (0-based)
3. **Quoted MCP_INPUT:** `"--MCP_INPUT:key"` or `'--MCP_INPUT:key'` -> value
4. **Quoted MCP_ARG:** `"--MCP_ARG_N"` or `'--MCP_ARG_N'` -> value
5. **Expression MCP_INPUT:** `(--MCP_INPUT:key` or `,--MCP_INPUT:key` -> value
6. **Expression MCP_ARG:** `(--MCP_ARG_N` or `,--MCP_ARG_N` -> value

The order matters: quoted forms are matched first, then expression context forms. This
prevents double-substitution.

### Missing Values

When a placeholder has no matching input, it resolves to the bare keyword `missing value`
(AppleScript's equivalent of null). This allows scripts to handle optional parameters:

```applescript
-- If mailboxName is not provided, --MCP_INPUT:mailboxName becomes: missing value
on setDefaultMailbox(mailboxInput)
  if mailboxInput is missing value or mailboxInput is "" then
    return "INBOX"
  end if
end setDefaultMailbox
```

### Debugging Substitutions

Set `include_substitution_logs: true` in the execute_script call to see detailed logs:

```
[SUBST] quotedMcpInputRegex replacing {"match":"\"--MCP_INPUT:recipientEmail\"","keyName":"recipientEmail","snakeKeyName":"recipient_email","replacementValue":"\"user@example.com\""}
```

---

## 8. AppleScript vs JXA Support

### Dual Language Support

The system supports both AppleScript and JXA transparently. Language is determined by:

1. For `kb_script_id`: from the tip's `language` field (parsed from code block type)
2. For `script_content`/`script_path`: from the `language` parameter (default: applescript)

### AppleScript Execution

```bash
osascript -s h -e 'tell application "Finder" to get name of every item of desktop'
```

- Default output mode: `-s h` (human-readable)
- Scripts use `tell application` blocks, handlers (`on`), properties

### JXA Execution

```bash
osascript -l JavaScript -e 'var app = Application("Finder"); app.desktop.items.name();'
```

- Uses `-l JavaScript` flag
- Default output mode: no `-s` flags (direct)
- Scripts use `Application()`, standard JavaScript syntax
- Can bridge to Objective-C via `ObjC.import()` and `$.NSObject`

### JXA Knowledge Base Coverage

The 03_jxa_core category (49 scripts) provides comprehensive JXA reference:

```javascript
// JXA Application targeting
var Finder = Application("Finder");
var Safari = Application("Safari");

// Standard Additions (for dialogs, clipboard, etc.)
var app = Application.currentApplication();
app.includeStandardAdditions = true;

// Accessing properties (0-based indexing in JXA!)
var desktopItems = Finder.desktop.items.length;

// ObjC Bridge
ObjC.import('Cocoa');
var pasteboard = $.NSPasteboard.generalPasteboard;
```

### Key Differences in KB Scripts

| Aspect | AppleScript | JXA |
|---|---|---|
| Code block marker | `` ```applescript `` | `` ```javascript `` |
| App reference | `tell application "X"` | `Application("X")` |
| Indexing | 1-based | 0-based |
| String handling | `text item delimiters` | Standard JS string methods |
| Error handling | `try...on error` | `try...catch` |
| Shell commands | `do shell script` | `app.doShellScript()` or `$.NSTask` |
| Output format | `-s h` (human-readable) | No `-s` flags (direct) |

---

## 9. Error Handling Patterns

### Server-Level Error Handling

The server (`server.ts`) catches multiple error types:

```typescript
// Platform check
if (execError.name === "UnsupportedPlatformError")
  throw McpError(ErrorCode.InvalidRequest, message);

// File access error
if (execError.name === "ScriptFileAccessError")
  throw McpError(ErrorCode.InvalidParams, message);

// Timeout
if (execError.isTimeout)
  throw McpError(ErrorCode.RequestTimeout, `Timed out after ${timeout}s`);

// Permission detection (regex pattern)
const permissionPattern = /Not authorized|access for assistive devices|errAEEventNotPermitted|errAEAccessDenied|-1743|-10004/i;
```

### Script-Level Error Handling

Every KB script follows this pattern:

```applescript
on mainFunction(args)
  tell application "Mail"
    try
      -- Main logic here
      -- Validate inputs first
      if someInput is missing value then
        return "Error: Input is required"
      end if

      -- Do the work
      -- ...

      -- Return success message
      return "Success: Did the thing"
    on error errMsg
      return "Error doing the thing: " & errMsg
    end try
  end tell
end mainFunction
```

### isError Detection

The server detects errors in stdout using a regex:

```typescript
const errorPattern = /^\s*error[:\s-]/i;
if (errorPattern.test(result.stdout)) {
  isError = true;
}
```

This means scripts should prefix error messages with "Error" for proper detection.

### Permission Error Enhancement

When permission errors are detected (via regex on stderr or exit code 1 with no stderr),
the server appends a helpful message pointing to System Settings > Privacy & Security.

---

## 10. Shared Handlers

The `_shared_handlers/` directory contains reusable AppleScript handler files:

### file_system_helpers.applescript

```applescript
on hfsPathToPOSIX(hfsPath)     -- Convert HFS to POSIX path
on posixPathToHFS(posixPath)    -- Convert POSIX to HFS path
on getFileExtension(fileName)   -- Extract file extension
on createDirectory(posixPath)   -- mkdir -p
on fileExists(posixPath)        -- test -e
on readTextFile(posixPath)      -- cat
on writeTextFile(posixPath, textContent)  -- echo > file
on getFileModDate(posixPath)    -- stat file modification date
```

### string_utils.applescript

```applescript
on trimString(theString)           -- Trim whitespace
on splitString(theString, delim)   -- Split by delimiter
on joinList(theList, delim)        -- Join with delimiter
on stringContains(str, sub)        -- Contains check
on replaceString(str, old, new)    -- Replace all occurrences
on toLowerCase(theString)          -- tr upper lower
on toUpperCase(theString)          -- tr lower upper
on capitalizeWords(theString)      -- Capitalize first letter of each word
```

**Note:** These shared handlers are loaded by the KB manager and are available as a concept,
but the current system does NOT automatically inject them into scripts. They exist as reference
implementations that individual scripts can copy from. The `ScriptingTip.usesSharedHandlers`
field is defined in the type but commented out as "placeholder for future."

---

## 11. AI Script Selection Mechanism

### How the AI Discovers Scripts

The flow is designed as a two-step process:

1. **Discovery:** AI calls `get_scripting_tips` with a natural language `search_term`
   (e.g., "send email from Mail app") or browses by `category`.

2. **Execution:** AI takes the `kb_script_id` and `argumentsPrompt` from the search results,
   then calls `execute_script` with the appropriate `input_data`.

### Fuse.js Fuzzy Search Configuration

```typescript
const FUSE_OPTIONS_KEYS = [
  { name: 'title', weight: 0.4 },      // Highest weight on title
  { name: 'id', weight: 0.3 },          // Script ID is next
  { name: 'keywords', weight: 0.2 },    // Keywords
  { name: 'description', weight: 0.1 }, // Description
  { name: 'script', weight: 0.05 }      // Even script content is searchable
];
```

**Search thresholds:**
- Primary: 0.4 (tight match)
- Broad fallback: 0.7 (loose match, only if primary returns nothing)

### Tool Description as LLM Guidance

The `get_scripting_tips` tool description is carefully crafted to guide LLM behavior:

> "This tool is essential for discovery and should be the FIRST CHOICE when aiming to automate
> macOS tasks, especially those involving common applications or system functions, before
> attempting to write scripts from scratch."

This tells the LLM to prefer KB scripts over writing from scratch.

### Result Format

Search results return Markdown with:
- Script title and description
- Full script source code
- Runnable ID (for direct execution)
- Arguments prompt (what inputs are needed)
- Keywords
- Notes

This gives the AI everything it needs to decide whether to use the script and how to call it.

---

## 12. Reusable Patterns and Scripts for Our Tool

### Scripts We Could Directly Reuse

#### Mail.app Automation
The entire Mail.app script collection is directly reusable for any macOS mail automation tool:
- `mail_get_unread_count` -- Quick inbox status check
- `mail_search_messages` -- Search by subject/sender/content
- `mail_send_email_direct` -- Programmatic email sending
- `mail_summarize_inbox` -- Inbox analytics
- `mail_save_attachments` -- Attachment extraction
- `mail_check_for_replies` -- Follow-up tracking

#### Browser Automation
- Safari/Chrome URL and tab management scripts
- JavaScript injection patterns
- Screenshot capture scripts

#### System Control
- Volume control, dark mode toggle
- Notification sending
- Display brightness
- WiFi toggle

#### Terminal Automation
- Run command and get output
- Kill process by port
- Terminal tab/window management

### Architecture Patterns to Adopt

#### 1. Knowledge Base Pattern
The markdown-with-frontmatter approach is excellent:
- Self-documenting (each script has title, description, keywords, notes)
- Searchable (Fuse.js fuzzy search over metadata)
- Extensible (users can add local overrides)
- Version-controllable (plain text files)

We could adopt this for our own AppleScript/shell script collections.

#### 2. Placeholder Substitution
The `--MCP_INPUT:key` pattern is a clean way to make scripts parameterizable without
modifying script structure. Advantages:
- Scripts remain valid AppleScript (placeholders are in comments or strings)
- Default value handling is built into the script logic
- Type conversion is automatic (string, number, boolean, array, record)

#### 3. Handler-Based Script Structure
The pattern of defining named handlers + calling at bottom:

```applescript
on doTheWork(param1, param2)
  -- implementation
end doTheWork

return my doTheWork("--MCP_INPUT:param1", "--MCP_INPUT:param2")
```

This makes scripts:
- Testable (handlers can be called independently)
- Composable (multiple handlers in one script)
- Self-documenting (handler names describe functionality)

#### 4. Error Message Convention
Prefix errors with "Error:" for automated detection:
```applescript
return "Error: No messages selected"
```
This simple convention enables the server to set `isError` on responses.

### What We Should Build Differently

1. **Use Bun instead of Node** -- Our tools run on Bun, so we would use `Bun.spawn()` instead
   of `child_process.execFile`.

2. **Direct `osascript` wrapper** -- Rather than the full MCP server overhead, we could build
   a simpler utility function that wraps `osascript` execution with timeout and error handling.

3. **Selective script loading** -- Rather than loading all ~500 scripts, load only the categories
   needed for a specific tool.

4. **JXA preference** -- For new scripts, prefer JXA over AppleScript since it uses JavaScript
   syntax that LLMs are more familiar with, and provides better JSON handling.

---

## 13. Comparison with apple-mcp Approach

### Architecture Differences

| Aspect | macos-automator-mcp | apple-mcp (typical) |
|---|---|---|
| **Execution engine** | `osascript` CLI | Native Swift/ObjC bridges or osascript |
| **Script storage** | Markdown files with frontmatter | Hardcoded in source or JSON configs |
| **Discovery** | Fuzzy search via Fuse.js | Predefined tool list |
| **Parameterization** | Placeholder substitution | Function arguments |
| **Language support** | AppleScript + JXA | Usually AppleScript only |
| **Knowledge base** | ~500 scripts, extensible | Usually <50 fixed scripts |
| **Local customization** | User override KB at ~/.macos-automator/ | No override mechanism |
| **Accessibility queries** | Dedicated `ax` binary tool | Usually not included |

### Strengths of macos-automator-mcp

1. **Massive script library** -- 498 scripts covering virtually every macOS app
2. **Discoverability** -- LLM can search for scripts by natural language
3. **Extensibility** -- Users can add/override scripts without modifying source
4. **Dual language** -- Both AppleScript and JXA
5. **Accessibility tool** -- Can query and interact with UI elements directly
6. **Self-documenting** -- Each script has metadata, description, and notes

### Weaknesses of macos-automator-mcp

1. **osascript overhead** -- Every execution spawns a new `osascript` process
2. **No persistent state** -- Cannot maintain application connections between calls
3. **String-based substitution** -- Placeholder system is fragile (regex-based, order-dependent)
4. **Node.js requirement** -- Cannot run on Bun without modification
5. **Large footprint** -- Loading 500 markdown files is heavy for simple use cases
6. **UI scripting fragility** -- Scripts using System Events break across macOS versions

### Strengths of apple-mcp Approach

1. **Lightweight** -- Fixed set of well-tested tools
2. **Type-safe** -- Direct TypeScript interfaces for parameters
3. **Focused** -- Purpose-built for specific workflows
4. **Stable** -- Fewer moving parts, less likely to break

### When to Choose Which

- **macos-automator-mcp**: When you need broad coverage across many apps, when the LLM needs
  to discover automation capabilities, or when building a general-purpose macOS automation agent.

- **apple-mcp / custom tool**: When you have specific, well-defined automation needs, when you
  want tighter integration with your toolchain, or when performance matters (avoid the KB loading
  overhead).

### Hybrid Approach for Our Tool

The best approach for GenesisTools would be:

1. **Cherry-pick scripts** from macos-automator-mcp's knowledge base for specific needs
   (Mail.app, browser automation, system control)
2. **Adopt the frontmatter markdown format** for our own script collections
3. **Build a simpler executor** using `Bun.spawn()` for `osascript` without the full MCP overhead
4. **Use JXA for new scripts** where possible (better JSON handling, familiar syntax)
5. **Skip the Fuse.js search** in favor of direct script ID lookup (we know what we need)

---

## 14. Key Takeaways

### For Building macOS Automation Tools

1. **osascript is the universal entry point.** Both AppleScript and JXA run through it.
   The key flags are `-l JavaScript` for JXA and `-s h` for human-readable output.

2. **Scripts should be self-contained.** Each script should handle its own defaults,
   validation, and error reporting. The "handler + bottom invocation" pattern works well.

3. **Return strings, not structured data.** Scripts communicate results as formatted text
   strings. For structured data, use JXA which can return JSON directly.

4. **Permission errors are common.** Always detect and provide helpful guidance about
   System Settings > Privacy & Security > Automation/Accessibility.

5. **UI scripting is a last resort.** Prefer app-native AppleScript commands over
   System Events UI automation. UI scripting breaks across macOS versions.

### For Our Specific Needs

1. **Mail.app scripts are production-ready.** The 28 Mail scripts cover the full lifecycle:
   read (get unread, search, summarize), write (compose, send, reply), organize (move, flag,
   archive), and analyze (statistics, check for replies).

2. **Browser scripts are comprehensive.** Safari and Chrome automation covers URL management,
   tab control, JavaScript injection, screenshots, and form filling.

3. **The knowledge base format is worth adopting.** Markdown + YAML frontmatter is a clean,
   extensible, self-documenting way to store automation scripts.

4. **JXA is underused but powerful.** JXA scripts can use standard JavaScript, import ObjC
   frameworks, handle JSON natively, and are generally more maintainable than AppleScript.

5. **The placeholder system works but is fragile.** For our tools, consider passing arguments
   via `on run argv` (AppleScript) or `run(argv)` (JXA) instead of string substitution,
   or at minimum use a simpler token format.

### Script Counts Summary

| Area | Count |
|---|---|
| Total markdown tip files | 498 |
| Total categories | 13 (with subcategories) |
| Mail.app scripts | 28 |
| Browser scripts (Safari+Chrome+Firefox) | 72 |
| Developer tools scripts | 92 |
| Creative app scripts | 61 |
| System control scripts | 26 |
| AppleScript language reference tips | 50 |
| JXA language reference tips | 49 |
| Shared handler files | 2 (.applescript) |

---

*Document generated from exploration of steipete/macos-automator-mcp at commit depth=1,
February 2026.*
