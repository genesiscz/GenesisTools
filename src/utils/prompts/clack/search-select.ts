/**
 * Interactive search select prompt (single-select).
 * Allows users to filter a long list by typing and select a single item.
 *
 * Based on search-multiselect.ts but for single selection.
 */

import pc from "picocolors";
import * as readline from "readline";
import { Writable } from "stream";

import type { SearchItem } from "./search-multiselect.js";
export type { SearchItem };

// Silent writable stream to prevent readline from echoing input
const silentOutput = new Writable({
    write(_chunk, _encoding, callback) {
        callback();
    },
});

export interface SearchSelectOptions<T> {
    message: string;
    items: SearchItem<T>[];
    maxVisible?: number;
    onHighlight?: (item: SearchItem<T>) => void;
}

// Symbols for consistent styling
const S_STEP_ACTIVE = pc.green("\u25C6");
const S_STEP_CANCEL = pc.red("\u25A0");
const S_STEP_SUBMIT = pc.green("\u25C7");
const S_BAR = pc.dim("\u2502");

export const searchSelectCancelSymbol = Symbol("cancel");

/**
 * Interactive search select prompt.
 * Allows users to filter a long list by typing and select a single item.
 * Press Enter to confirm the currently highlighted item.
 */
export async function searchSelect<T>(options: SearchSelectOptions<T>): Promise<T | symbol> {
    const { message, items, maxVisible = 8, onHighlight } = options;

    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: silentOutput,
            terminal: false,
        });

        // Enable raw mode for keypress detection
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        readline.emitKeypressEvents(process.stdin, rl);

        let query = "";
        let cursor = 0;
        let lastRenderHeight = 0;

        const filter = (item: SearchItem<T>, q: string): boolean => {
            if (!q) return true;
            const lowerQ = q.toLowerCase();
            return item.label.toLowerCase().includes(lowerQ) || String(item.value).toLowerCase().includes(lowerQ);
        };

        const getFiltered = (): SearchItem<T>[] => {
            return items.filter((item) => filter(item, query));
        };

        const emitHighlight = (): void => {
            if (!onHighlight) return;
            const filtered = getFiltered();
            const item = filtered[cursor];
            if (item) onHighlight(item);
        };

        const clearRender = (): void => {
            if (lastRenderHeight > 0) {
                // Move up and clear each line
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
            const filtered = getFiltered();

            // Header
            const icon = state === "active" ? S_STEP_ACTIVE : state === "cancel" ? S_STEP_CANCEL : S_STEP_SUBMIT;
            lines.push(`${icon}  ${pc.bold(message)}`);

            if (state === "active") {
                // Search input
                const searchLine = `${S_BAR}  ${pc.dim("Search:")} ${query}${pc.inverse(" ")}`;
                lines.push(searchLine);

                // Hint
                lines.push(`${S_BAR}  ${pc.dim("\u2191\u2193 move, enter select")}`);
                lines.push(`${S_BAR}`);

                // Items
                const visibleStart = Math.max(
                    0,
                    Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible)
                );
                const visibleEnd = Math.min(filtered.length, visibleStart + maxVisible);
                const visibleItems = filtered.slice(visibleStart, visibleEnd);

                if (filtered.length === 0) {
                    lines.push(`${S_BAR}  ${pc.dim("No matches found")}`);
                } else {
                    for (let i = 0; i < visibleItems.length; i++) {
                        const item = visibleItems[i]!;
                        const actualIndex = visibleStart + i;
                        const isCursor = actualIndex === cursor;

                        const label = isCursor ? pc.underline(item.label) : item.label;
                        const hint = item.hint ? pc.dim(` (${item.hint})`) : "";

                        const prefix = isCursor ? pc.cyan("\u276F") : " ";
                        lines.push(`${S_BAR} ${prefix} ${label}${hint}`);
                    }

                    // Show count if more items
                    const hiddenBefore = visibleStart;
                    const hiddenAfter = filtered.length - visibleEnd;
                    if (hiddenBefore > 0 || hiddenAfter > 0) {
                        const parts: string[] = [];
                        if (hiddenBefore > 0) parts.push(`\u2191 ${hiddenBefore} more`);
                        if (hiddenAfter > 0) parts.push(`\u2193 ${hiddenAfter} more`);
                        lines.push(`${S_BAR}  ${pc.dim(parts.join("  "))}`);
                    }
                }

                lines.push(`${pc.dim("\u2514")}`);
            } else if (state === "submit") {
                // Final state - show what was selected
                const selectedItem = getFiltered()[cursor];
                if (selectedItem) {
                    lines.push(`${S_BAR}  ${pc.dim(selectedItem.label)}`);
                }
            } else if (state === "cancel") {
                lines.push(`${S_BAR}  ${pc.strikethrough(pc.dim("Cancelled"))}`);
            }

            process.stdout.write(lines.join("\n") + "\n");
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
            const filtered = getFiltered();
            const item = filtered[cursor];
            if (!item) return; // nothing to select
            render("submit");
            cleanup();
            resolve(item.value);
        };

        const cancel = (): void => {
            render("cancel");
            cleanup();
            resolve(searchSelectCancelSymbol);
        };

        // Handle keypresses
        const keypressHandler = (_str: string, key: readline.Key): void => {
            if (!key) return;

            const filtered = getFiltered();

            if (key.name === "return") {
                submit();
                return;
            }

            if (key.name === "escape" || (key.ctrl && key.name === "c")) {
                cancel();
                return;
            }

            if (key.name === "up") {
                cursor = Math.max(0, cursor - 1);
                emitHighlight();
                render();
                return;
            }

            if (key.name === "down") {
                cursor = filtered.length > 0 ? Math.min(filtered.length - 1, cursor + 1) : 0;
                emitHighlight();
                render();
                return;
            }

            if (key.name === "backspace") {
                query = query.slice(0, -1);
                cursor = 0;
                emitHighlight();
                render();
                return;
            }

            // Regular character input
            if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
                query += key.sequence;
                cursor = 0;
                emitHighlight();
                render();
                return;
            }
        };

        process.stdin.on("keypress", keypressHandler);

        // Initial render + highlight callback
        emitHighlight();
        render();
    });
}
