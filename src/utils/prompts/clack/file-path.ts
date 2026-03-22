/**
 * Interactive file path input with zsh-style tab completion and live directory listing.
 * Reusable utility — not specific to any tool.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as readline from "node:readline";
import { Writable } from "node:stream";
import pc from "picocolors";

// Silent writable stream to prevent readline from echoing input
const silentOutput = new Writable({
    write(_chunk, _encoding, callback) {
        callback();
    },
});

// Clack-consistent symbols
const S_STEP_ACTIVE = pc.green("\u25C6");
const S_STEP_CANCEL = pc.red("\u25A0");
const S_STEP_SUBMIT = pc.green("\u25C7");
const S_BAR = pc.dim("\u2502");

export const filePathCancelSymbol = Symbol("cancel");

export interface FilePathInputOptions {
    message: string;
    /** Initial path value. Defaults to cwd + "/" */
    initialValue?: string;
    /** Show live directory listing below input as user types. Default: true */
    listPossibilities?: boolean;
    /** Filter: "all" | "directories" | "files". Default: "all" */
    filter?: "all" | "directories" | "files";
    /** File extension filter, e.g. [".srt", ".vtt"] */
    extensions?: string[];
    /** Max entries to show in the listing. Default: 12 */
    maxVisible?: number;
}

interface DirEntry {
    name: string;
    isDirectory: boolean;
}

/**
 * Interactive file path input with zsh-style tab completion.
 *
 * Features:
 * - Live directory listing below input as you type
 * - Tab completion (single match → complete, multiple → common prefix)
 * - Arrow keys to navigate listing, Enter to select
 * - ~/  and ./ expansion
 * - Two-column layout: name on left, type on right
 */
export async function filePathInput(options: FilePathInputOptions): Promise<string | symbol> {
    const {
        message,
        initialValue = `${process.cwd()}/`,
        listPossibilities = true,
        filter = "all",
        extensions,
        maxVisible = 12,
    } = options;

    return new Promise((resolvePromise) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: silentOutput,
            terminal: false,
        });

        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }

        readline.emitKeypressEvents(process.stdin, rl);

        let value = initialValue;
        let cursor = -1; // -1 = input focused (no listing highlight)
        let lastRenderHeight = 0;

        const expandPath = (p: string): string => {
            if (p.startsWith("~/")) {
                return join(homedir(), p.slice(2));
            }

            if (p.startsWith("./")) {
                return join(process.cwd(), p.slice(2));
            }

            if (!p.startsWith("/")) {
                return join(process.cwd(), p);
            }

            return p;
        };

        const readDir = (): DirEntry[] => {
            const expanded = expandPath(value);
            let dir: string;
            let prefix: string;

            if (value.endsWith("/")) {
                dir = expanded;
                prefix = "";
            } else {
                dir = dirname(expanded);
                prefix = basename(expanded).toLowerCase();
            }

            try {
                const entries = readdirSync(dir, { withFileTypes: true });
                const result: DirEntry[] = [];

                for (const entry of entries) {
                    if (entry.name.startsWith(".")) {
                        continue;
                    }

                    const isDir = entry.isDirectory();

                    if (filter === "directories" && !isDir) {
                        continue;
                    }

                    if (filter === "files" && isDir) {
                        continue;
                    }

                    if (extensions && !isDir) {
                        const hasExt = extensions.some((ext) => entry.name.endsWith(ext));

                        if (!hasExt) {
                            continue;
                        }
                    }

                    if (prefix && !entry.name.toLowerCase().startsWith(prefix)) {
                        continue;
                    }

                    result.push({ name: entry.name, isDirectory: isDir });
                }

                result.sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) {
                        return a.isDirectory ? -1 : 1;
                    }

                    return a.name.localeCompare(b.name);
                });

                return result;
            } catch {
                return [];
            }
        };

        const getCommonPrefix = (entries: DirEntry[]): string => {
            if (entries.length === 0) {
                return "";
            }

            let common = entries[0].name;

            for (let i = 1; i < entries.length; i++) {
                const name = entries[i].name;
                let j = 0;

                while (j < common.length && j < name.length && common[j] === name[j]) {
                    j++;
                }

                common = common.slice(0, j);
            }

            return common;
        };

        const clearRender = (): void => {
            if (lastRenderHeight > 0) {
                process.stdout.write(`\x1b[${lastRenderHeight}A`);

                for (let i = 0; i < lastRenderHeight; i++) {
                    process.stdout.write("\x1b[2K\x1b[1B");
                }

                process.stdout.write(`\x1b[${lastRenderHeight}A`);
            }
        };

        const render = (state: "active" | "submit" | "cancel" = "active"): void => {
            clearRender();

            const lines: string[] = [];

            // Header
            const icon = state === "active" ? S_STEP_ACTIVE : state === "cancel" ? S_STEP_CANCEL : S_STEP_SUBMIT;
            lines.push(`${icon}  ${pc.bold(message)}`);

            if (state === "active") {
                // Input line with cursor
                const cursorChar = cursor === -1 ? pc.inverse(" ") : " ";
                lines.push(`${S_BAR}  ${value}${cursorChar}`);

                if (listPossibilities) {
                    const entries = readDir();

                    if (entries.length > 0) {
                        lines.push(`${S_BAR}`);

                        // Compute column widths
                        const maxNameLen = Math.min(
                            50,
                            Math.max(
                                ...entries.slice(0, maxVisible).map((e) => (e.name + (e.isDirectory ? "/" : "")).length)
                            )
                        );

                        const visibleEntries = entries.slice(0, maxVisible);

                        for (let i = 0; i < visibleEntries.length; i++) {
                            const entry = visibleEntries[i];
                            const displayName = entry.name + (entry.isDirectory ? "/" : "");
                            const typeLabel = entry.isDirectory ? "directory" : "file";
                            const padded = displayName.padEnd(maxNameLen + 4);
                            const isCur = i === cursor;

                            if (isCur) {
                                lines.push(
                                    `${S_BAR}  ${pc.cyan("\u276F")} ${pc.underline(padded)}${pc.dim(typeLabel)}`
                                );
                            } else {
                                lines.push(`${S_BAR}    ${padded}${pc.dim(typeLabel)}`);
                            }
                        }

                        if (entries.length > maxVisible) {
                            lines.push(`${S_BAR}    ${pc.dim(`\u2193 ${entries.length - maxVisible} more`)}`);
                        }
                    } else {
                        lines.push(`${S_BAR}`);
                        lines.push(`${S_BAR}    ${pc.dim("No matches")}`);
                    }
                }

                lines.push(`${S_BAR}  ${pc.dim("tab complete · \u2191\u2193 navigate · enter select")}`);
                lines.push(`${pc.dim("\u2514")}`);
            } else if (state === "submit") {
                lines.push(`${S_BAR}  ${pc.dim(value)}`);
            } else if (state === "cancel") {
                lines.push(`${S_BAR}  ${pc.strikethrough(pc.dim("Cancelled"))}`);
            }

            process.stdout.write(`${lines.join("\n")}\n`);
            lastRenderHeight = lines.length;
        };

        const cleanup = (): void => {
            process.stdin.removeListener("keypress", keypressHandler);

            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }

            rl.close();
        };

        const submit = (): void => {
            render("submit");
            cleanup();
            resolvePromise(expandPath(value));
        };

        const cancel = (): void => {
            render("cancel");
            cleanup();
            resolvePromise(filePathCancelSymbol);
        };

        const tabComplete = (): void => {
            const entries = readDir();

            if (entries.length === 0) {
                return;
            }

            if (entries.length === 1) {
                // Single match — complete it
                const entry = entries[0];
                const dir = value.endsWith("/") ? value : value.slice(0, value.lastIndexOf("/") + 1);
                value = dir + entry.name + (entry.isDirectory ? "/" : "");
                cursor = -1;
                render();
                return;
            }

            // Multiple matches — complete common prefix
            const common = getCommonPrefix(entries);

            if (common) {
                const dir = value.endsWith("/") ? value : value.slice(0, value.lastIndexOf("/") + 1);
                const currentBasename = value.endsWith("/") ? "" : basename(value);

                if (common.length > currentBasename.length) {
                    value = dir + common;
                    cursor = -1;
                    render();
                }
            }
        };

        const selectEntry = (): void => {
            const entries = readDir();

            if (cursor < 0 || cursor >= entries.length) {
                return;
            }

            const entry = entries[cursor];
            const dir = value.endsWith("/") ? value : value.slice(0, value.lastIndexOf("/") + 1);
            value = dir + entry.name + (entry.isDirectory ? "/" : "");
            cursor = -1;
            render();
        };

        const keypressHandler = (_str: string, key: readline.Key): void => {
            if (!key) {
                return;
            }

            if (key.name === "return") {
                if (cursor >= 0) {
                    selectEntry();
                } else {
                    submit();
                }

                return;
            }

            if (key.name === "escape" || (key.ctrl && key.name === "c")) {
                cancel();
                return;
            }

            if (key.name === "tab") {
                tabComplete();
                return;
            }

            if (key.name === "up") {
                const entries = readDir();

                if (entries.length > 0) {
                    cursor = cursor <= 0 ? -1 : cursor - 1;
                    render();
                }

                return;
            }

            if (key.name === "down") {
                const entries = readDir();

                if (entries.length > 0) {
                    const max = Math.min(entries.length - 1, maxVisible - 1);
                    cursor = cursor < max ? cursor + 1 : max;
                    render();
                }

                return;
            }

            if (key.name === "backspace") {
                if (value.length > 0) {
                    value = value.slice(0, -1);
                    cursor = -1;
                    render();
                }

                return;
            }

            // Regular character input
            if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
                value += key.sequence;
                cursor = -1;
                render();
                return;
            }
        };

        process.stdin.on("keypress", keypressHandler);
        render();
    });
}
