import clipboardy from "clipboardy";
import pc from "picocolors";

export async function copyToClipboard(
    content: string,
    options: { silent?: boolean; label?: string } = {},
): Promise<void> {
    await clipboardy.write(content);

    if (!options.silent) {
        const label = options.label ? ` (${options.label})` : "";
        console.error(pc.green(`✓ Copied to clipboard${label}`));
    }
}

export async function readFromClipboard(): Promise<string> {
    return clipboardy.read();
}
