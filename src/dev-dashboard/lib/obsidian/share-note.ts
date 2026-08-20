import { isAbsolute, relative, resolve } from "node:path";
import { getConfig } from "@app/dev-dashboard/config";
import { publishNote } from "@app/dev-dashboard/lib/obsidian/publish";
import { readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import { sharePageUrl } from "@app/dev-dashboard/lib/public-base";
import { normalizeVaultPath } from "@genesiscz/utils/obsidian/paths";

/**
 * Turn a CLI path (vault-relative or absolute) into the same vault-relative
 * `.md` string the UI publish button posts to `/api/obsidian/publish`.
 */
export function toVaultRelativePath(input: string, vaultRoot: string): string {
    const trimmed = input.trim();

    if (!trimmed) {
        throw new Error("path required");
    }

    const root = resolve(vaultRoot);
    const full = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);

    if (full !== root && !full.startsWith(`${root}/`)) {
        throw new Error(`Path escapes vault: ${trimmed}`);
    }

    let rel = normalizeVaultPath(relative(root, full));

    if (!rel || rel === ".") {
        throw new Error("path required");
    }

    if (!rel.endsWith(".md")) {
        rel = `${rel}.md`;
    }

    return rel;
}

export async function shareNote(inputPath: string): Promise<{ url: string; slug: string; vaultPath: string }> {
    const { obsidianVault } = await getConfig();

    if (!obsidianVault) {
        throw new Error("obsidian vault not configured");
    }

    const vaultPath = toVaultRelativePath(inputPath, obsidianVault);
    await readNote(obsidianVault, vaultPath);
    const note = await publishNote(vaultPath);
    const url = await sharePageUrl(note.slug);

    return { url, slug: note.slug, vaultPath };
}
