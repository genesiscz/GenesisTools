#!/usr/bin/env bun

// Tells a new Claude, Codex or Grok session when to use the native GenesisTools inbox (the widget), and prints
// NOTHING on a Mac without the native app, so other users of this plugin never hear about it.
//
// A plugin file that runs is copied out of the repository, so it cannot import the state function
// (src/utils/macos/native-inbox.ts). It reads what that function writes instead:
//   ~/.genesis-tools/app/native-inbox.json  { version, installed, bundles[], widgetLocks[] }
// No file means no native app. `installed` counts only while one of its bundles still exists. "running" is decided
// here, live, from the widget locks: each holds the pid record of the `tools hub widget watch` process the widget
// keeps alive while it is open. The texts and the mapping are pinned to the TypeScript ones by
// native-inbox-hint.test.ts; edit src/question/lib/inbox-guidance.ts first.
//
// Grok 1.0.44 ignores SessionStart stdout (see agents-talk-hint.ts), so Grok learns the same text from the
// genesis-tools MCP server instructions.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SafeJSON = JSON;

export type InboxState = "none" | "installed" | "running";

export const RUNNING_HINT =
    'INBOX: the user\'s GenesisTools widget is running on this Mac, and its inbox reaches the user even when they are not watching this chat. Post there only when you need the user: a decision you cannot make yourself, as a question_post item with type "decision" (CLI: `tools question ask --json -`); or a finished long task, a blocker, or a result they must see (attach the screenshot), as inbox_send with the screenshot paths in `images` (CLI: `tools question message "<text>" --image /abs/shot.png`). Never post routine progress or anything you can decide yourself. Also write every question in your chat reply.';

export const INSTALLED_HINT =
    'INBOX: the GenesisTools app is installed on this Mac, but its widget is not running, so nobody may see the inbox. You may still post a decision, as a question_post item with type "decision" (CLI: `tools question ask --json -`), or a message or screenshot, as inbox_send with the screenshot paths in `images` (CLI: `tools question message "<text>" --image /abs/shot.png`). But ALWAYS also ask the user directly in this chat, with your native question tool or in your reply.';

export interface InboxStateRecord {
    installed?: unknown;
    bundles?: unknown;
    widgetLocks?: unknown;
}

export interface HookIo {
    exists: (path: string) => boolean;
    readText: (path: string) => string | null;
    /** The live command line of a pid (`ps -o command=`), or null when no such process runs. */
    commandOf: (pid: number) => string | null;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The rule of `isLiveWidgetLock` in src/utils/macos/native-inbox.ts, which asks the pidfile module: the lock names the
 * widget watcher, and its pid still runs that exact command line, so a recycled pid never reads as a running widget.
 */
export function isLiveWidgetLock(text: string, commandOf: (pid: number) => string | null): boolean {
    let record: unknown;

    try {
        record = SafeJSON.parse(text);
    } catch {
        // A lock caught mid-write is not a pid record yet; it does not prove a running widget.
        return false;
    }

    const { pid, command } = (record ?? {}) as { pid?: unknown; command?: unknown };
    return (
        typeof pid === "number" &&
        Number.isInteger(pid) &&
        pid > 0 &&
        typeof command === "string" &&
        /(?:^|\s)widget\s(?:.*\s)?watch(?:\s|$)/.test(command) &&
        commandOf(pid) === command.trim()
    );
}

export function inboxStateFromRecord(record: InboxStateRecord | null, io: HookIo): InboxState {
    if (record?.installed !== true || !strings(record.bundles).some((bundle) => io.exists(bundle))) {
        return "none";
    }

    const running = strings(record.widgetLocks).some((lock) => {
        const text = io.readText(lock);
        return text !== null && isLiveWidgetLock(text, io.commandOf);
    });

    return running ? "running" : "installed";
}

export function hintFor(state: InboxState): string {
    if (state === "running") {
        return RUNNING_HINT;
    }

    return state === "installed" ? INSTALLED_HINT : "";
}

export function stateFilePath(): string {
    // Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
    return join(process.env.GENESIS_TOOLS_HOME || homedir(), ".genesis-tools", "app", "native-inbox.json");
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // A missing file is the normal case: no native app, or no widget data root yet.
        return null;
    }
}

function commandOf(pid: number): string | null {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
    const command = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    return command || null;
}

export function readRecord(path = stateFilePath()): InboxStateRecord | null {
    const text = readText(path);

    if (text === null) {
        return null;
    }

    try {
        return SafeJSON.parse(text) as InboxStateRecord;
    } catch (error) {
        process.stderr.write(`native-inbox-hint: ${path} is not valid JSON (${String(error)}); saying nothing\n`);
        return null;
    }
}

if (import.meta.main) {
    const hint = hintFor(inboxStateFromRecord(readRecord(), { exists: existsSync, readText, commandOf }));

    if (hint) {
        process.stdout.write(
            `${SafeJSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: hint } })}\n`
        );
    }
}
