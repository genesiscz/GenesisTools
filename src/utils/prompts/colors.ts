/**
 * Shared color constants and utilities for CLI tools.
 * Works with both @inquirer/prompts and @clack/prompts.
 */
import pc from "picocolors";

// ANSI 256-color constants for advanced styling
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[38;5;102m"; // Darker gray for secondary text
export const TEXT = "\x1b[38;5;145m"; // Lighter gray for primary text
export const CYAN = "\x1b[36m";
export const MAGENTA = "\x1b[35m";
export const YELLOW = "\x1b[33m";

// Logo gradient (for ASCII art if needed)
export const GRAYS = [
    "\x1b[38;5;250m",
    "\x1b[38;5;248m",
    "\x1b[38;5;245m",
    "\x1b[38;5;243m",
    "\x1b[38;5;240m",
    "\x1b[38;5;238m",
];

// Re-export picocolors for convenience
export { pc };

// Common styled outputs
export const styled = {
    error: (msg: string) => `${pc.bgRed(pc.white(pc.bold(" ERROR ")))} ${pc.red(msg)}`,
    success: (msg: string) => `${pc.green("✓")} ${msg}`,
    info: (msg: string) => `${pc.cyan("ℹ")} ${msg}`,
    warning: (msg: string) => `${pc.yellow("⚠")} ${msg}`,
    dim: (msg: string) => pc.dim(msg),
    highlight: (msg: string) => pc.cyan(msg),
    bold: (msg: string) => pc.bold(msg),
};

// Re-export shared format utilities for backward compatibility
export { formatBytes, formatDuration, formatList } from "../format";
