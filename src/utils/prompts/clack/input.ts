/**
 * Lightweight input prompt with two modes:
 * - "text": Full @clack/prompts p.text() (form-style with box framing)
 * - "light": Minimal readline-based REPL input (inline, no box/frame)
 */

import * as readline from "node:readline";
import { Writable } from "node:stream";
import * as p from "@clack/prompts";
import pc from "picocolors";

export interface InputOptions {
    message: string;
    mode: "text" | "light";
    placeholder?: string;
    validate?: (value: string) => string | undefined;
}

// Clack-consistent symbols
const S_STEP_ACTIVE = pc.green("\u25C6");
const S_STEP_CANCEL = pc.red("\u25A0");

export const inputCancelSymbol = Symbol("cancel");

// Silent writable stream to prevent readline from echoing input
const silentOutput = new Writable({
    write(_chunk, _encoding, callback) {
        callback();
    },
});

/**
 * Input prompt with two modes.
 * - "text" mode delegates to p.text() from @clack/prompts
 * - "light" mode is a minimal inline prompt for REPL-style usage
 */
export async function input(options: InputOptions): Promise<string | symbol> {
    if (options.mode === "text") {
        return p.text({
            message: options.message,
            placeholder: options.placeholder,
            validate: options.validate ? (value) => options.validate?.(value ?? "") : undefined,
        });
    }

    // "light" mode: minimal readline prompt
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: silentOutput,
            terminal: false,
        });

        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        readline.emitKeypressEvents(process.stdin, rl);

        let value = "";
        let errorMsg = "";

        const renderPrompt = (): void => {
            // Clear current line
            process.stdout.write("\x1b[2K\r");
            if (errorMsg) {
                process.stdout.write(`${pc.red(errorMsg)}\n`);
                errorMsg = "";
            }
            const prefix = `${S_STEP_ACTIVE}  ${options.message} `;
            process.stdout.write(`${prefix}${value}`);
        };

        const cleanup = (): void => {
            process.stdin.removeListener("keypress", keypressHandler);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            rl.close();
        };

        const submit = (): void => {
            if (options.validate) {
                const err = options.validate(value);
                if (err) {
                    errorMsg = err;
                    renderPrompt();
                    return;
                }
            }
            // Move to next line after submit
            process.stdout.write("\n");
            cleanup();
            resolve(value);
        };

        const cancel = (): void => {
            process.stdout.write("\x1b[2K\r");
            process.stdout.write(`${S_STEP_CANCEL}  ${pc.strikethrough(pc.dim(options.message))}\n`);
            cleanup();
            resolve(inputCancelSymbol);
        };

        const keypressHandler = (_str: string, key: readline.Key): void => {
            if (!key) return;

            if (key.name === "return") {
                submit();
                return;
            }

            if (key.name === "escape" || (key.ctrl && key.name === "c")) {
                cancel();
                return;
            }

            if (key.name === "backspace") {
                value = value.slice(0, -1);
                renderPrompt();
                return;
            }

            // Regular character input
            if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
                value += key.sequence;
                renderPrompt();
                return;
            }
        };

        process.stdin.on("keypress", keypressHandler);
        renderPrompt();
    });
}
