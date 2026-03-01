# Phase 4: Watch TUI (Ink Live Chat)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an interactive live chat terminal UI using Ink (React for terminals). Users watch a conversation in real-time, send messages by typing, and use slash commands (/ask, /suggest, /model, /attachment, /style, /careful, /quit) for AI features. Single contact view with a chat list to quickly switch contacts.

**Architecture:** Ink app with React components. `WatchSession` manages shared state (messages, contact, client, store). The TUI renders a message list + input bar. Slash commands are parsed in the input handler and dispatched to the appropriate engine (AI engines come in Phase 5, but the command routing is built here).

**Tech Stack:** Ink 6, React 19, @clack/prompts (for pre-TUI setup), Commander

**Prerequisites:** Phase 2 (sync), Phase 3 (V2 config) complete

**Existing Ink patterns to follow:** `src/claude/commands/usage/app.tsx`, `src/utils/ink/components/`, `src/utils/ink/hooks/`

---

## Task 1: WatchSession — Shared State Manager

**Files:**
- Create: `src/telegram/runtime/shared/WatchSession.ts`

**Context:** WatchSession holds the current contact, message buffer, client, store, and provides methods for sending messages, loading history, and handling slash commands. It's framework-agnostic (not React-specific) so both light and ink runtimes can use it.

**Step 1: Implement WatchSession**

```typescript
import type { TGClient } from "../../lib/TGClient";
import type { TelegramHistoryStore } from "../../lib/TelegramHistoryStore";
import type { TelegramContactV2, MessageRowV2 } from "../../lib/types";
import { TelegramMessage } from "../../lib/TelegramMessage";
import { ConversationSyncService } from "../../lib/ConversationSyncService";

export interface WatchMessage {
    id: number;
    text: string;
    isOutgoing: boolean;
    senderName: string;
    date: Date;
    mediaDesc?: string;
}

export type InputMode = "chat" | "careful";

export class WatchSession {
    private messages: WatchMessage[] = [];
    private listeners: Array<() => void> = [];
    private _inputMode: InputMode = "chat";
    private _currentContact: TelegramContactV2;
    private syncService: ConversationSyncService;

    constructor(
        private client: TGClient,
        private store: TelegramHistoryStore,
        private myName: string,
        contact: TelegramContactV2,
        private allContacts: TelegramContactV2[],
    ) {
        this._currentContact = contact;
        this.syncService = new ConversationSyncService(client, store);
    }

    get currentContact(): TelegramContactV2 { return this._currentContact; }
    get inputMode(): InputMode { return this._inputMode; }
    get contextLength(): number { return this._currentContact.watch?.contextLength ?? 30; }

    /** Load recent messages from DB */
    async loadHistory(): Promise<void> {
        const rows = this.store.queryMessages(this._currentContact.userId, {
            limit: this.contextLength,
        });

        this.messages = rows.map((r) => ({
            id: r.id,
            text: r.text ?? "",
            isOutgoing: r.is_outgoing === 1,
            senderName: r.is_outgoing === 1 ? this.myName : this._currentContact.displayName,
            date: new Date(r.date_unix * 1000),
            mediaDesc: r.media_desc ?? undefined,
        }));

        this.notify();
    }

    /** Subscribe to state changes */
    subscribe(listener: () => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    private notify() {
        for (const l of this.listeners) l();
    }

    /** Get messages for rendering */
    getMessages(): WatchMessage[] {
        return this.messages.slice(-this.contextLength);
    }

    /** Get all configured contacts for chat list */
    getContacts(): TelegramContactV2[] {
        return this.allContacts;
    }

    /** Add incoming message (from event handler) */
    addIncoming(msg: TelegramMessage): void {
        this.messages.push({
            id: msg.id,
            text: msg.text,
            isOutgoing: false,
            senderName: this._currentContact.displayName,
            date: msg.date,
            mediaDesc: msg.mediaDescription,
        });
        this.notify();
    }

    /** Send a message */
    async sendMessage(text: string): Promise<void> {
        const sent = await this.client.sendMessage(this._currentContact.userId, text);
        this.store.insertMessages(this._currentContact.userId, [{
            id: sent.id,
            senderId: undefined, // self
            text,
            mediaDescription: undefined,
            isOutgoing: true,
            date: new Date().toISOString(),
            dateUnix: Math.floor(Date.now() / 1000),
        }]);

        this.messages.push({
            id: sent.id,
            text,
            isOutgoing: true,
            senderName: this.myName,
            date: new Date(),
        });
        this.notify();
    }

    /** Switch to a different contact */
    async switchContact(contact: TelegramContactV2): Promise<void> {
        this._currentContact = contact;
        this.messages = [];
        await this.loadHistory();
    }

    /** Toggle input mode */
    toggleCarefulMode(): void {
        this._inputMode = this._inputMode === "chat" ? "careful" : "chat";
        this.notify();
    }

    /** Parse and route slash commands. Returns true if handled. */
    async handleSlashCommand(input: string): Promise<{ handled: boolean; output?: string }> {
        const trimmed = input.trim();
        if (!trimmed.startsWith("/")) {
            return { handled: false };
        }

        const parts = trimmed.slice(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(" ");

        switch (cmd) {
            case "careful":
                this.toggleCarefulMode();
                return { handled: true, output: `Input mode: ${this._inputMode}` };

            case "send":
                if (this._inputMode === "careful" && args) {
                    await this.sendMessage(args);
                    return { handled: true };
                }
                return { handled: true, output: "Usage: /send <message>" };

            case "quit":
            case "exit":
                return { handled: true, output: "__EXIT__" };

            case "ask":
                // Placeholder — AI engine hooks in Phase 5
                return { handled: true, output: `[assistant] ${args}` };

            case "suggest":
                // Placeholder — Suggestion engine hooks in Phase 5
                return { handled: true, output: "[suggestions loading...]" };

            case "model":
                // Placeholder — model switching hooks in Phase 5
                return { handled: true, output: "[model selector]" };

            case "style":
                // Placeholder — style derivation hooks in Phase 5
                return { handled: true, output: "[style profile]" };

            case "attachment": {
                const msgId = Number.parseInt(args, 10);
                if (Number.isNaN(msgId)) {
                    return { handled: true, output: "Usage: /attachment <message_id>" };
                }
                const atts = this.store.getAttachments(this._currentContact.userId, msgId);
                if (atts.length === 0) {
                    return { handled: true, output: "No attachments for this message" };
                }
                const list = atts.map((a) =>
                    `  [${a.attachment_index}] ${a.kind} ${a.file_name ?? ""} ${a.is_downloaded ? "✓" : "✗"}`
                ).join("\n");
                return { handled: true, output: `Attachments:\n${list}` };
            }

            case "help":
                return {
                    handled: true,
                    output: [
                        "Commands:",
                        "  /ask <question>     Ask assistant about the conversation",
                        "  /suggest            Generate reply suggestions",
                        "  /send <text>        Send message (required in /careful mode)",
                        "  /careful            Toggle careful mode (require /send)",
                        "  /model              Switch AI model",
                        "  /style              Derive/preview style profile",
                        "  /attachment <id>    List/download attachments",
                        "  /contacts           Switch to contact list",
                        "  /quit               Exit watch mode",
                    ].join("\n"),
                };

            default:
                return { handled: true, output: `Unknown command: /${cmd}. Type /help for available commands.` };
        }
    }
}
```

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 3: Commit**

```bash
git add src/telegram/runtime/shared/WatchSession.ts
git commit -m "feat(telegram): WatchSession state manager with slash command routing"
```

---

## Task 2: Ink Components — Message List

**Files:**
- Create: `src/telegram/runtime/ink/components/MessageList.tsx`

**Step 1: Implement MessageList**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { WatchMessage } from "../../shared/WatchSession";

interface MessageListProps {
    messages: WatchMessage[];
    contactName: string;
}

export function MessageList({ messages, contactName }: MessageListProps) {
    if (messages.length === 0) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text dimColor>No messages yet. Start typing to send a message.</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
            ))}
        </Box>
    );
}

function MessageBubble({ message }: { message: WatchMessage }) {
    const time = formatTime(message.date);
    const prefix = message.isOutgoing ? "→" : "←";
    const nameColor = message.isOutgoing ? "cyan" : "green";

    return (
        <Box>
            <Text dimColor>{time} </Text>
            <Text color={nameColor}>{prefix} {message.senderName}: </Text>
            <Text>{message.text}</Text>
            {message.mediaDesc && <Text dimColor> [{message.mediaDesc}]</Text>}
        </Box>
    );
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}
```

**Step 2: Commit**

```bash
git add src/telegram/runtime/ink/components/MessageList.tsx
git commit -m "feat(telegram): Ink MessageList component"
```

---

## Task 3: Ink Components — Input Bar

**Files:**
- Create: `src/telegram/runtime/ink/components/InputBar.tsx`

**Step 1: Implement InputBar**

```tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { InputMode } from "../../shared/WatchSession";

interface InputBarProps {
    mode: InputMode;
    contactName: string;
    onSubmit: (text: string) => void;
}

export function InputBar({ mode, contactName, onSubmit }: InputBarProps) {
    const [value, setValue] = useState("");

    const handleSubmit = (text: string) => {
        if (!text.trim()) return;
        onSubmit(text.trim());
        setValue("");
    };

    const modeIndicator = mode === "careful" ? " [CAREFUL]" : "";
    const prompt = `${contactName}${modeIndicator} > `;

    return (
        <Box borderStyle="single" borderColor="gray" paddingLeft={1}>
            <Text color={mode === "careful" ? "yellow" : "blue"}>{prompt}</Text>
            <TextInput
                value={value}
                onChange={setValue}
                onSubmit={handleSubmit}
                placeholder={mode === "careful" ? "Use /send <msg> to send..." : "Type a message or /help..."}
            />
        </Box>
    );
}
```

**Step 2: Commit**

```bash
git add src/telegram/runtime/ink/components/InputBar.tsx
git commit -m "feat(telegram): Ink InputBar component with mode indicator"
```

---

## Task 4: Ink Components — Status Bar and Contact List

**Files:**
- Create: `src/telegram/runtime/ink/components/StatusBar.tsx`
- Create: `src/telegram/runtime/ink/components/ContactList.tsx`

**Step 1: Implement StatusBar**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { TelegramContactV2 } from "../../../lib/types";

interface StatusBarProps {
    contact: TelegramContactV2;
    messageCount: number;
    inputMode: string;
    systemMessage?: string;
}

export function StatusBar({ contact, messageCount, inputMode, systemMessage }: StatusBarProps) {
    const typeEmoji = contact.chatType === "group" ? "👥" : contact.chatType === "channel" ? "📢" : "👤";

    return (
        <Box borderStyle="single" borderColor="blue" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <Text color="blue" bold>
                {typeEmoji} {contact.displayName}
                {contact.username ? ` (@${contact.username})` : ""}
            </Text>
            <Box gap={2}>
                {systemMessage && <Text color="yellow">{systemMessage}</Text>}
                <Text dimColor>{messageCount} msgs</Text>
                <Text dimColor>mode: {inputMode}</Text>
                <Text dimColor>Tab: contacts</Text>
            </Box>
        </Box>
    );
}
```

**Step 2: Implement ContactList**

```tsx
import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { TelegramContactV2 } from "../../../lib/types";

interface ContactListProps {
    contacts: TelegramContactV2[];
    currentContactId: string;
    onSelect: (contact: TelegramContactV2) => void;
    onBack: () => void;
}

export function ContactList({ contacts, currentContactId, onSelect, onBack }: ContactListProps) {
    const items = contacts.map((c) => {
        const typeIcon = c.chatType === "group" ? "👥" : c.chatType === "channel" ? "📢" : "👤";
        const current = c.userId === currentContactId ? " ◀" : "";
        return {
            label: `${typeIcon} ${c.displayName}${current}`,
            value: c.userId,
        };
    });

    const handleSelect = (item: { value: string }) => {
        const contact = contacts.find((c) => c.userId === item.value);
        if (contact) {
            onSelect(contact);
        }
    };

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="blue">Select a contact (Esc to go back):</Text>
            <Box marginTop={1}>
                <SelectInput items={items} onSelect={handleSelect} />
            </Box>
        </Box>
    );
}
```

**Step 3: Commit**

```bash
git add src/telegram/runtime/ink/components/StatusBar.tsx src/telegram/runtime/ink/components/ContactList.tsx
git commit -m "feat(telegram): Ink StatusBar and ContactList components"
```

---

## Task 5: Ink Components — System Output

**Files:**
- Create: `src/telegram/runtime/ink/components/SystemOutput.tsx`

**Context:** Shows system messages (command output, AI responses, suggestions, errors) in a distinct area between messages and input.

**Step 1: Implement SystemOutput**

```tsx
import React from "react";
import { Box, Text } from "ink";

interface SystemOutputProps {
    lines: Array<{ text: string; type: "info" | "error" | "suggestion" | "assistant" }>;
}

export function SystemOutput({ lines }: SystemOutputProps) {
    if (lines.length === 0) return null;

    const colorMap = {
        info: "gray" as const,
        error: "red" as const,
        suggestion: "magenta" as const,
        assistant: "cyan" as const,
    };

    return (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingLeft={1} marginTop={1} marginBottom={1}>
            {lines.map((line, i) => (
                <Text key={i} color={colorMap[line.type]}>
                    {line.text}
                </Text>
            ))}
        </Box>
    );
}
```

**Step 2: Commit**

```bash
git add src/telegram/runtime/ink/components/SystemOutput.tsx
git commit -m "feat(telegram): Ink SystemOutput component for command/AI feedback"
```

---

## Task 6: Main Ink App — WatchInkApp

**Files:**
- Create: `src/telegram/runtime/ink/WatchInkApp.tsx`

**Context:** This is the top-level Ink app that composes all components, manages state via WatchSession, handles keyboard events, and routes input.

**Step 1: Implement WatchInkApp**

```tsx
import React, { useState, useEffect, useCallback } from "react";
import { Box, useApp, useInput } from "ink";
import { MessageList } from "./components/MessageList";
import { InputBar } from "./components/InputBar";
import { StatusBar } from "./components/StatusBar";
import { ContactList } from "./components/ContactList";
import { SystemOutput } from "./components/SystemOutput";
import type { WatchSession, WatchMessage } from "../shared/WatchSession";
import type { TelegramContactV2 } from "../../lib/types";

type View = "chat" | "contacts";

interface SystemLine {
    text: string;
    type: "info" | "error" | "suggestion" | "assistant";
}

interface WatchInkAppProps {
    session: WatchSession;
}

export function WatchInkApp({ session }: WatchInkAppProps) {
    const { exit } = useApp();
    const [messages, setMessages] = useState<WatchMessage[]>(session.getMessages());
    const [view, setView] = useState<View>("chat");
    const [systemLines, setSystemLines] = useState<SystemLine[]>([]);

    // Subscribe to session changes
    useEffect(() => {
        const unsub = session.subscribe(() => {
            setMessages([...session.getMessages()]);
        });
        return unsub;
    }, [session]);

    // Handle Tab key for switching views
    useInput((input, key) => {
        if (key.tab) {
            setView((v) => (v === "chat" ? "contacts" : "chat"));
        }
    });

    const clearSystemLines = useCallback(() => {
        setTimeout(() => setSystemLines([]), 10000); // auto-clear after 10s
    }, []);

    const handleSubmit = useCallback(async (text: string) => {
        // Clear previous system output
        setSystemLines([]);

        // Check for slash command
        if (text.startsWith("/")) {
            const result = await session.handleSlashCommand(text);

            if (result.output === "__EXIT__") {
                exit();
                return;
            }

            if (result.handled && result.output) {
                setSystemLines([{ text: result.output, type: "info" }]);
                clearSystemLines();
            }
            return;
        }

        // Regular message
        if (session.inputMode === "careful") {
            setSystemLines([{ text: "Careful mode: use /send <message> to send", type: "info" }]);
            clearSystemLines();
            return;
        }

        try {
            await session.sendMessage(text);
        } catch (err) {
            setSystemLines([{
                text: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
                type: "error",
            }]);
        }
    }, [session, exit, clearSystemLines]);

    const handleContactSelect = useCallback(async (contact: TelegramContactV2) => {
        await session.switchContact(contact);
        setView("chat");
    }, [session]);

    if (view === "contacts") {
        return (
            <ContactList
                contacts={session.getContacts()}
                currentContactId={session.currentContact.userId}
                onSelect={handleContactSelect}
                onBack={() => setView("chat")}
            />
        );
    }

    return (
        <Box flexDirection="column" height="100%">
            <StatusBar
                contact={session.currentContact}
                messageCount={messages.length}
                inputMode={session.inputMode}
            />
            <Box flexDirection="column" flexGrow={1}>
                <MessageList
                    messages={messages}
                    contactName={session.currentContact.displayName}
                />
            </Box>
            <SystemOutput lines={systemLines} />
            <InputBar
                mode={session.inputMode}
                contactName={session.currentContact.displayName}
                onSubmit={handleSubmit}
            />
        </Box>
    );
}
```

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 3: Commit**

```bash
git add src/telegram/runtime/ink/WatchInkApp.tsx
git commit -m "feat(telegram): WatchInkApp main Ink application"
```

---

## Task 7: Watch Command

**Files:**
- Create: `src/telegram/commands/watch.ts`
- Modify: `src/telegram/index.ts`

**Step 1: Implement watch command**

```typescript
import { Command } from "commander";
import * as p from "@clack/prompts";
import { render } from "ink";
import React from "react";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import { WatchSession } from "../runtime/shared/WatchSession";
import { WatchInkApp } from "../runtime/ink/WatchInkApp";
import { TelegramMessage } from "../lib/TelegramMessage";
import { ConversationSyncService } from "../lib/ConversationSyncService";

export function registerWatchCommand(program: Command) {
    program
        .command("watch [contact]")
        .description("Watch a conversation in real-time with AI assistant features")
        .option("--context-length <n>", "Number of recent messages to show", parseInt)
        .action(async (contactArg, opts) => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data?.session) {
                p.log.error("Not configured. Run: tools telegram configure");
                process.exit(1);
            }

            const client = TGClient.fromConfig(config);
            const connected = await client.connect();

            if (!connected) {
                p.log.error("Failed to connect. Re-run: tools telegram configure");
                process.exit(1);
            }

            const me = await client.getMe();
            const myName = [me.firstName, me.lastName].filter(Boolean).join(" ");

            const store = new TelegramHistoryStore();
            store.open();

            // Resolve contact
            let contact = contactArg
                ? data.contacts.find(
                    (c) => c.displayName.toLowerCase() === contactArg.toLowerCase()
                        || c.userId === contactArg
                        || c.username?.toLowerCase() === contactArg.toLowerCase()
                )
                : undefined;

            if (!contact) {
                // Interactive contact selection
                const choices = data.contacts.map((c) => {
                    const icon = c.chatType === "group" ? "👥" : c.chatType === "channel" ? "📢" : "👤";
                    return { value: c.userId, label: `${icon} ${c.displayName}` };
                });

                const selected = await p.select({
                    message: "Which conversation to watch?",
                    options: choices,
                });

                if (p.isCancel(selected)) process.exit(0);
                contact = data.contacts.find((c) => c.userId === selected);
            }

            if (!contact) {
                p.log.error("Contact not found");
                process.exit(1);
            }

            // Override context length if provided
            if (opts.contextLength) {
                contact = { ...contact, watch: { ...contact.watch, contextLength: opts.contextLength } };
            }

            // Sync latest messages before starting
            const spinner = p.spinner();
            spinner.start("Syncing latest messages...");
            const syncService = new ConversationSyncService(client, store);
            const syncResult = await syncService.syncLatest(contact.userId);
            spinner.stop(`Synced ${syncResult.synced} new messages`);

            // Create session
            const session = new WatchSession(client, store, myName, contact, data.contacts);
            await session.loadHistory();

            // Register incoming message handler for this contact
            client.onNewMessage(async (event) => {
                const msg = new TelegramMessage(event.message);
                const senderId = msg.senderId;

                if (senderId === contact!.userId || String(event.message?.peerId?.chatId) === contact!.userId) {
                    // Persist
                    store.insertMessages(contact!.userId, [msg.toJSON()]);
                    // Push to session
                    session.addIncoming(msg);
                }
            });

            // Render Ink app
            p.log.info(`Watching ${contact.displayName}. Tab to switch contacts, /help for commands.`);
            const { waitUntilExit } = render(
                React.createElement(WatchInkApp, { session }),
            );

            await waitUntilExit();

            // Cleanup
            store.close();
            await client.disconnect();
        });
}
```

**Step 2: Register in index.ts**

Add to `src/telegram/index.ts`:

```typescript
import { registerWatchCommand } from "./commands/watch";
registerWatchCommand(program);
```

**Step 3: Update listen.ts as compatibility alias**

At the end of `registerListenCommand` in `listen.ts`, add a note that `listen` is now a backward-compatible alias. No functional changes needed — `listen` continues to work as the daemon-style handler.

**Step 4: Type check and commit**

```bash
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/commands/watch.ts src/telegram/index.ts
git commit -m "feat(telegram): watch command with Ink live chat TUI"
```

---

## Task 8: Wire Incoming Messages to Watch Session (Event Bridge)

**Files:**
- Modify: `src/telegram/runtime/ink/WatchInkApp.tsx`

**Context:** The watch command registers `client.onNewMessage` above, but we also need to handle messages from OTHER contacts (to show unread badges in the contact list) and handle group messages where `peerId` may be the group ID.

**Step 1: Add unread tracking to WatchSession**

Add to `src/telegram/runtime/shared/WatchSession.ts`:

```typescript
private unreadCounts = new Map<string, number>();

incrementUnread(contactId: string): void {
    const current = this.unreadCounts.get(contactId) ?? 0;
    this.unreadCounts.set(contactId, current + 1);
    this.notify();
}

getUnreadCount(contactId: string): number {
    return this.unreadCounts.get(contactId) ?? 0;
}

clearUnread(contactId: string): void {
    this.unreadCounts.delete(contactId);
}
```

Update `switchContact` to clear unreads:

```typescript
async switchContact(contact: TelegramContactV2): Promise<void> {
    this._currentContact = contact;
    this.messages = [];
    this.clearUnread(contact.userId);
    await this.loadHistory();
}
```

**Step 2: Update ContactList to show unread badges**

In `ContactList.tsx`:

```tsx
interface ContactListProps {
    contacts: TelegramContactV2[];
    currentContactId: string;
    unreadCounts: Map<string, number>;
    onSelect: (contact: TelegramContactV2) => void;
    onBack: () => void;
}

// In the items mapping:
const unread = unreadCounts.get(c.userId) ?? 0;
const badge = unread > 0 ? ` (${unread})` : "";
return {
    label: `${typeIcon} ${c.displayName}${badge}${current}`,
    value: c.userId,
};
```

**Step 3: Commit**

```bash
git add src/telegram/runtime/shared/WatchSession.ts src/telegram/runtime/ink/components/ContactList.tsx
git commit -m "feat(telegram): unread message tracking in watch session"
```

---

## Task 9: Phase 4 Verification

**Step 1: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 2: Lint**

```bash
bunx biome check src/telegram
```

**Step 3: Manual smoke test**

```bash
# Launch watch mode
tools telegram watch

# Should show contact selector → pick a contact → see message history
# Type a message → it should send
# Type /help → see command list
# Type /careful → toggle careful mode
# Tab → switch to contact list
```

**Step 4: Commit fixes**

```bash
git add src/telegram/
git commit -m "fix(telegram): Phase 4 verification fixes"
```

---

## Summary of Phase 4 Deliverables

| Component | File | Status |
|-----------|------|--------|
| WatchSession state manager | `src/telegram/runtime/shared/WatchSession.ts` | Task 1 |
| MessageList component | `src/telegram/runtime/ink/components/MessageList.tsx` | Task 2 |
| InputBar component | `src/telegram/runtime/ink/components/InputBar.tsx` | Task 3 |
| StatusBar component | `src/telegram/runtime/ink/components/StatusBar.tsx` | Task 4 |
| ContactList component | `src/telegram/runtime/ink/components/ContactList.tsx` | Task 4 |
| SystemOutput component | `src/telegram/runtime/ink/components/SystemOutput.tsx` | Task 5 |
| WatchInkApp main app | `src/telegram/runtime/ink/WatchInkApp.tsx` | Task 6 |
| watch command | `src/telegram/commands/watch.ts` | Task 7 |
| Unread tracking | `WatchSession.ts`, `ContactList.tsx` | Task 8 |
