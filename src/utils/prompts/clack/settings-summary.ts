/**
 * Reusable settings summary display for CLI tools.
 * Shows a formatted list of settings before execution.
 */

import pc from "picocolors";

const S_STEP_SUBMIT = pc.green("\u25C7");
const S_BAR = pc.dim("\u2502");

export interface SettingsEntry {
    label: string;
    value: string;
    /** Dim hint after value, e.g. "(default)" or "(from --provider)" */
    hint?: string;
}

/**
 * Print a formatted settings summary using clack-style symbols.
 *
 * ```
 * ◇  Provider: local-hf (from --provider)
 * ◇  Model: whisper-large-v3-turbo (default)
 * ◇  Format: text
 * ◇  Output: stdout
 * ```
 */
export function printSettingsSummary(entries: SettingsEntry[]): void {
    for (const entry of entries) {
        const hint = entry.hint ? ` ${pc.dim(`(${entry.hint})`)}` : "";
        console.log(`${S_BAR}`);
        console.log(`${S_STEP_SUBMIT}  ${pc.dim(`${entry.label}:`)} ${entry.value}${hint}`);
    }

    console.log(`${S_BAR}`);
}
