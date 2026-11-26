import { isAbsolute, relative, resolve } from "node:path";
import { getConfig } from "@app/dev-dashboard/config";
import { findPublishedByPath } from "@app/dev-dashboard/lib/obsidian/publish";
import { readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import { codeLanguageFor } from "@app/dev-dashboard/lib/obsidian/share-assets";
import { SHARE_SLUG_RE } from "@app/dev-dashboard/lib/share/source";
import { shareToTargets, type TargetOutcome } from "@app/dev-dashboard/lib/share/targets";
import { normalizeVaultPath } from "@genesiscz/utils/obsidian/paths";

/**
 * Turn a CLI path (vault-relative or absolute) into the same vault-relative
 * `.md` string the UI publish button posts to `/api/obsidian/publish`. A source
 * file (`Report.ts` beside its report) keeps its own extension.
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

    if (!rel.endsWith(".md") && !codeLanguageFor(rel)) {
        rel = `${rel}.md`;
    }

    return rel;
}

/**
 * Publish a vault note and send it to the share targets `targetNames` picks (none: the publish default;
 * "all": every target). Each target answers with its link or its error.
 */
export async function shareNote(
    inputPath: string,
    targetNames: readonly string[] = []
): Promise<{ slug: string; vaultPath: string; outcomes: TargetOutcome[]; alreadyPublished: boolean }> {
    const vaultPath = await vaultPathFor(inputPath);
    const { obsidianVault } = await getConfig();
    await readNote(obsidianVault ?? "", vaultPath);
    // A note shared again keeps its id and link; the run only sends it again.
    const alreadyPublished = (await findPublishedByPath(vaultPath)) !== undefined;
    const { note, outcomes } = await shareToTargets({ vaultPath, targetNames });

    return { slug: note.slug, vaultPath, outcomes, alreadyPublished };
}

async function vaultPathFor(inputPath: string): Promise<string> {
    const { obsidianVault } = await getConfig();

    if (!obsidianVault) {
        throw new Error("obsidian vault not configured");
    }

    return toVaultRelativePath(inputPath, obsidianVault);
}

/** A slug, or the slug of the published note at a vault path (what `share unshare` and `share sync` accept). */
export async function resolvePublishedSlug(input: string): Promise<string> {
    if (SHARE_SLUG_RE.test(input) && !input.includes(".")) {
        return input;
    }

    const note = await findPublishedByPath(await vaultPathFor(input));

    if (!note) {
        throw new Error(`not published: ${input}`);
    }

    return note.slug;
}
