/**
 * Multiline text input for @clack/prompts
 * Handles pasted multiline content (like cURL commands)
 */
import pc from "picocolors";

export interface MultilineOptions {
    message: string;
    placeholder?: string;
    /** Validate the final input */
    validate?: (value: string) => string | undefined;
}

const S_STEP_ACTIVE = pc.green("◆");
const S_STEP_SUBMIT = pc.green("◇");
const S_STEP_CANCEL = pc.red("■");
const S_BAR = pc.dim("│");

/**
 * Multiline text input that properly handles pasted content.
 *
 * - Paste multiline text (like cURL commands) and it will capture all lines
 * - Press Enter twice on empty line to submit
 * - Press Ctrl+C or Escape to cancel
 * - Arrow keys move cursor, backspace deletes at cursor
 */
export async function multilineText(options: MultilineOptions): Promise<string | symbol> {
    const { message, placeholder, validate } = options;

    return new Promise((resolve) => {
        let buffer = "";
        let cursorPos = 0; // Position within buffer
        let lastKeyTime = 0;
        let emptyEnterCount = 0;
        let renderLineCount = 0;

        const getLines = () => buffer.split("\n");

        // Get cursor line and column from buffer position
        const getCursorLineCol = () => {
            const before = buffer.slice(0, cursorPos);
            const lines = before.split("\n");
            return {
                line: lines.length - 1,
                col: lines[lines.length - 1].length,
            };
        };

        const clearRender = () => {
            if (renderLineCount > 0) {
                process.stdout.write(`\x1b[${renderLineCount}A`);
                for (let i = 0; i < renderLineCount; i++) {
                    process.stdout.write("\x1b[2K\x1b[1B");
                }
                process.stdout.write(`\x1b[${renderLineCount}A`);
            }
        };

        const render = (state: "active" | "submit" | "cancel" = "active") => {
            clearRender();

            const outputLines: string[] = [];
            const icon = state === "active" ? S_STEP_ACTIVE : state === "cancel" ? S_STEP_CANCEL : S_STEP_SUBMIT;

            outputLines.push(`${icon}  ${pc.bold(message)}`);

            if (state === "active") {
                outputLines.push(`${S_BAR}  ${pc.dim("Paste or type. Enter twice to submit, Ctrl+C to cancel")}`);

                const lines = getLines();
                const { line: cursorLine, col: cursorCol } = getCursorLineCol();
                const maxShow = 6;

                if (lines.length === 1 && lines[0] === "" && placeholder) {
                    outputLines.push(`${S_BAR}  ${pc.dim(placeholder)}${pc.inverse(" ")}`);
                } else if (lines.length <= maxShow) {
                    for (let i = 0; i < lines.length; i++) {
                        let display = lines[i];
                        if (display.length > 70) {
                            display = `${display.slice(0, 67)}...`;
                        }

                        // Show cursor on the correct line
                        if (i === cursorLine) {
                            const before = display.slice(0, Math.min(cursorCol, display.length));
                            const after = display.slice(Math.min(cursorCol, display.length));
                            display = before + pc.inverse(after[0] || " ") + (after.slice(1) || "");
                        }

                        outputLines.push(`${S_BAR}  ${display || " "}`);
                    }
                } else {
                    // Show first 3 and last 3
                    for (let i = 0; i < 3; i++) {
                        let display = lines[i].length > 70 ? `${lines[i].slice(0, 67)}...` : lines[i];
                        if (i === cursorLine) {
                            const before = display.slice(0, Math.min(cursorCol, display.length));
                            const after = display.slice(Math.min(cursorCol, display.length));
                            display = before + pc.inverse(after[0] || " ") + (after.slice(1) || "");
                        }
                        outputLines.push(`${S_BAR}  ${display || " "}`);
                    }
                    outputLines.push(`${S_BAR}  ${pc.dim(`... ${lines.length - 6} more lines ...`)}`);
                    for (let i = lines.length - 3; i < lines.length; i++) {
                        let display = lines[i].length > 70 ? `${lines[i].slice(0, 67)}...` : lines[i];
                        if (i === cursorLine) {
                            const before = display.slice(0, Math.min(cursorCol, display.length));
                            const after = display.slice(Math.min(cursorCol, display.length));
                            display = before + pc.inverse(after[0] || " ") + (after.slice(1) || "");
                        }
                        outputLines.push(`${S_BAR}  ${display || " "}`);
                    }
                }

                outputLines.push(pc.dim("└"));
            } else if (state === "submit") {
                const lines = getLines();
                outputLines.push(`${S_BAR}  ${pc.dim(`${lines.length} lines, ${buffer.length} chars`)}`);
            } else {
                outputLines.push(`${S_BAR}  ${pc.strikethrough(pc.dim("Cancelled"))}`);
            }

            process.stdout.write(`${outputLines.join("\n")}\n`);
            renderLineCount = outputLines.length;
        };

        const submit = () => {
            const trimmed = buffer.trim();

            if (validate) {
                const error = validate(trimmed);
                if (error) {
                    process.stdout.write(`\x1b[1A\x1b[2K`);
                    console.log(`${S_BAR}  ${pc.red(error)}`);
                    console.log(pc.dim("└"));
                    emptyEnterCount = 0;
                    return;
                }
            }

            cleanup();
            render("submit");
            resolve(trimmed);
        };

        const cancel = () => {
            cleanup();
            render("cancel");
            resolve(Symbol("cancel"));
        };

        const cleanup = () => {
            process.stdin.setRawMode(false);
            process.stdin.removeListener("data", onData);
            process.stdin.pause();
        };

        // Insert text at cursor position
        const insertAt = (text: string) => {
            buffer = buffer.slice(0, cursorPos) + text + buffer.slice(cursorPos);
            cursorPos += text.length;
        };

        // Delete character before cursor
        const deleteBack = () => {
            if (cursorPos > 0) {
                buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
                cursorPos--;
            }
        };

        const onData = (data: Buffer) => {
            const now = Date.now();
            const timeSinceLastKey = now - lastKeyTime;
            lastKeyTime = now;

            for (let i = 0; i < data.length; i++) {
                const byte = data[i];

                // Ctrl+C
                if (byte === 3) {
                    cancel();
                    return;
                }

                // Escape sequences
                if (byte === 27) {
                    if (i + 2 < data.length && data[i + 1] === 91) {
                        const code = data[i + 2];
                        // Arrow keys
                        if (code === 65) {
                            // Up
                            // Move to same column on previous line
                            const { line, col } = getCursorLineCol();
                            if (line > 0) {
                                const lines = getLines();
                                let newPos = 0;
                                for (let l = 0; l < line - 1; l++) {
                                    newPos += lines[l].length + 1;
                                }
                                newPos += Math.min(col, lines[line - 1].length);
                                cursorPos = newPos;
                            }
                            i += 2;
                            continue;
                        }
                        if (code === 66) {
                            // Down
                            const { line, col } = getCursorLineCol();
                            const lines = getLines();
                            if (line < lines.length - 1) {
                                let newPos = 0;
                                for (let l = 0; l <= line; l++) {
                                    newPos += lines[l].length + 1;
                                }
                                newPos += Math.min(col, lines[line + 1].length);
                                cursorPos = newPos;
                            }
                            i += 2;
                            continue;
                        }
                        if (code === 67) {
                            // Right
                            if (cursorPos < buffer.length) {
                                cursorPos++;
                            }
                            i += 2;
                            continue;
                        }
                        if (code === 68) {
                            // Left
                            if (cursorPos > 0) {
                                cursorPos--;
                            }
                            i += 2;
                            continue;
                        }
                        // Other escape sequences - skip
                        i += 2;
                        while (i < data.length && data[i] >= 32 && data[i] < 64) {
                            i++;
                        }
                        continue;
                    } else {
                        // Just ESC - cancel
                        cancel();
                        return;
                    }
                }

                // Enter
                if (byte === 13 || byte === 10) {
                    if (byte === 13 && i < data.length - 1 && data[i + 1] === 10) {
                        continue;
                    }

                    const lines = getLines();
                    const { line } = getCursorLineCol();
                    const currentLine = lines[line] || "";

                    if (timeSinceLastKey > 100 && currentLine === "" && cursorPos === buffer.length) {
                        emptyEnterCount++;
                        if (emptyEnterCount >= 1 && buffer.trim().length > 0) {
                            submit();
                            return;
                        }
                    } else {
                        emptyEnterCount = 0;
                    }

                    insertAt("\n");
                    continue;
                }

                // Backspace
                if (byte === 127 || byte === 8) {
                    deleteBack();
                    emptyEnterCount = 0;
                    continue;
                }

                // Delete key (ESC [ 3 ~)
                if (
                    byte === 27 &&
                    i + 3 < data.length &&
                    data[i + 1] === 91 &&
                    data[i + 2] === 51 &&
                    data[i + 3] === 126
                ) {
                    if (cursorPos < buffer.length) {
                        buffer = buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
                    }
                    i += 3;
                    continue;
                }

                // Tab
                if (byte === 9) {
                    insertAt("  ");
                    emptyEnterCount = 0;
                    continue;
                }

                // Printable ASCII
                if (byte >= 32 && byte < 127) {
                    insertAt(String.fromCharCode(byte));
                    emptyEnterCount = 0;
                    continue;
                }

                // UTF-8
                if (byte >= 128) {
                    let charBytes = 1;
                    if ((byte & 0xe0) === 0xc0) charBytes = 2;
                    else if ((byte & 0xf0) === 0xe0) charBytes = 3;
                    else if ((byte & 0xf8) === 0xf0) charBytes = 4;

                    if (i + charBytes <= data.length) {
                        const charData = data.subarray(i, i + charBytes);
                        insertAt(charData.toString("utf8"));
                        i += charBytes - 1;
                    }
                    emptyEnterCount = 0;
                }
            }

            render("active");
        };

        render("active");

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onData);
    });
}

export function isMultilineCancel(value: unknown): value is symbol {
    return typeof value === "symbol";
}
