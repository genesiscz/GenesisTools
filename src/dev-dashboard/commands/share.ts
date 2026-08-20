import { shareNote } from "@app/dev-dashboard/lib/obsidian/share-note";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { out } from "@genesiscz/utils/logger";

export interface ShareCommandOptions {
    clipboard: boolean;
}

/**
 * Same path as the Obsidian reader "publish" / "copy" buttons: register a
 * public `/share/<slug>` token, print the public URL, copy it to the clipboard.
 */
export async function runShare(path: string, opts: ShareCommandOptions): Promise<void> {
    try {
        const { url, vaultPath } = await shareNote(path);
        out.println(url);
        out.printlnErr(`published ${vaultPath}`);

        if (opts.clipboard) {
            await copyToClipboard(url, { label: "share URL" });
        }

        await out.flush();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out.error(message);
        await out.flush();
        process.exitCode = 1;
    }
}
