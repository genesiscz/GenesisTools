import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { appendToVault, clipToVault, readVaultInbox, writeVaultInbox } from "../lib/vault/index";

/**
 * `tools hub vault`: the phone's Send to my vault doors (F25): `clip <url>` (`POST /api/vault/clip`), `append <text>`
 * (`POST /api/vault/append`) and `config`, the inbox folder and note name both use.
 */
export function registerVaultCommand(program: Command): void {
    const vault = program.command("vault").description("Clip links and append text into the Obsidian vault inbox");

    vault
        .command("clip")
        .description("A page as Markdown, or a video queued for transcription, into the inbox note of the day")
        .argument("<url>", "an http or https link")
        .option("--note <text>", "a line above the clip")
        .option("--json", "machine-readable output")
        .action(async (url: string, opts: { note?: string; json?: boolean }) => {
            const receipt = await clipToVault({ url, note: opts.note });
            process.exitCode = receipt.error ? 1 : 0;

            if (opts.json) {
                out.result(receipt);
                return;
            }

            out.log.info(receipt.error ?? `Clipped into ${receipt.note}`);
        });

    vault
        .command("append")
        .description("Append text to a vault note (default: the inbox note of the day)")
        .argument("<text>", "the text")
        .option("--folder <path>", "a folder under the vault")
        .option("--name <note>", "the note name without .md")
        .option("--json", "machine-readable output")
        .action(async (text: string, opts: { folder?: string; name?: string; json?: boolean }) => {
            const receipt = await appendToVault({ text, folder: opts.folder, name: opts.name });

            if (opts.json) {
                out.result(receipt);
                return;
            }

            out.log.info(`Appended to ${receipt.note}`);
        });

    vault
        .command("config")
        .description("The inbox folder and the note name prefix (default: Inbox, one 'Phone inbox' note a day)")
        .option("--folder <path>", "a folder under the vault")
        .option("--prefix <text>", "the note name after the day")
        .option("--json", "machine-readable output")
        .action(async (opts: { folder?: string; prefix?: string; json?: boolean }) => {
            const current = await readVaultInbox();
            const next =
                opts.folder || opts.prefix
                    ? await writeVaultInbox({
                          folder: opts.folder ?? current.folder,
                          prefix: opts.prefix ?? current.prefix,
                      })
                    : current;

            if (opts.json) {
                out.result(next);
                return;
            }

            out.log.info(`Inbox: ${next.folder}/<day> ${next.prefix}.md`);
        });
}
