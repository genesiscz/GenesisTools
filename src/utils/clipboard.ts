import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export async function copyToClipboard(
    content: string,
    options: { silent?: boolean; label?: string } = {}
): Promise<void> {
    // lazy: saves 32.8 ms cold import (tools ts imports lazy, 2026-09-16) — clipboardy ships platform binaries and most runs never touch the clipboard
    const { default: clipboardy } = await import("clipboardy");
    await clipboardy.write(content);

    if (!options.silent) {
        const label = options.label ? ` (${options.label})` : "";
        out.error(pc.green(`✓ Copied to clipboard${label}`));
    }
}

export async function readFromClipboard(): Promise<string> {
    // lazy: saves 32.8 ms cold import (tools ts imports lazy, 2026-09-16) — same reason as copyToClipboard
    const { default: clipboardy } = await import("clipboardy");
    return clipboardy.read();
}
