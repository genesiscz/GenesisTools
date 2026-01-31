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

/**
 * Format a list of items, truncating if too long
 */
export function formatList(items: string[], maxShow = 5): string {
    if (items.length <= maxShow) {
        return items.join(", ");
    }
    const shown = items.slice(0, maxShow);
    const remaining = items.length - maxShow;
    return `${shown.join(", ")} +${remaining} more`;
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
