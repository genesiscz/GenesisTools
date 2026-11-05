import { relative } from "node:path";
import type {
    VaultAppendInput,
    VaultAppendReceiptDto,
    VaultClipInput,
    VaultClipReceiptDto,
} from "@app/dev-dashboard/contract/vault";
import { execTool, toolCommand } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";

/**
 * Send to my vault (F25): a link from the phone becomes clean Markdown in the vault's inbox note (`tools fetch`), a
 * video link is queued for transcription (`tools youtube queue add`) and noted there, and any text is appended to a
 * note. The inbox folder and note name are a setting (`tools hub vault config`), defaulting to `Inbox` and one note
 * per day.
 */

export interface VaultInboxConfig {
    /** A folder under the vault. */
    folder: string;
    /** The note name prefix; the day is added: `<YYYY-MM-DD> <prefix>`. */
    prefix: string;
}

const CONFIG_KEY = "vaultInbox";
export const DEFAULT_VAULT_INBOX: VaultInboxConfig = { folder: "Inbox", prefix: "Phone inbox" };

export async function readVaultInbox(storage = new Storage("hub")): Promise<VaultInboxConfig> {
    const stored = await storage.getConfigValue<Partial<VaultInboxConfig>>(CONFIG_KEY);
    return {
        folder:
            typeof stored?.folder === "string" && stored.folder.trim()
                ? stored.folder.trim()
                : DEFAULT_VAULT_INBOX.folder,
        prefix:
            typeof stored?.prefix === "string" && stored.prefix.trim()
                ? stored.prefix.trim()
                : DEFAULT_VAULT_INBOX.prefix,
    };
}

export async function writeVaultInbox(
    config: VaultInboxConfig,
    storage = new Storage("hub")
): Promise<VaultInboxConfig> {
    await storage.setConfigValue(CONFIG_KEY, config);
    return config;
}

function day(now: Date): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export interface VaultDeps {
    vaultRoot?: () => Promise<string | null>;
    save?: (opts: {
        vaultRoot: string;
        relativeDir: string;
        baseName: string;
        content: string;
    }) => Promise<{ path: string }>;
    inbox?: () => Promise<VaultInboxConfig>;
    run?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    now?: Date;
}

async function liveVaultRoot(): Promise<string | null> {
    const { getConfig } = await import("@app/dev-dashboard/config");
    return (await getConfig()).obsidianVault ?? null;
}

async function liveSave(opts: { vaultRoot: string; relativeDir: string; baseName: string; content: string }) {
    const { saveToObsidianUnique } = await import("@app/dev-dashboard/lib/obsidian-save");
    return saveToObsidianUnique({ ...opts, mode: "append", createDir: true });
}

/** Appends text to a vault note (the inbox note of the day when no folder and name are given). */
export async function appendToVault(input: VaultAppendInput, deps: VaultDeps = {}): Promise<VaultAppendReceiptDto> {
    const root = await (deps.vaultRoot ?? liveVaultRoot)();

    if (!root) {
        throw new Error(`No Obsidian vault is configured for the dashboard (${toolCommand("dev-dashboard config")}).`);
    }

    const inbox = await (deps.inbox ?? readVaultInbox)();
    const folder = input.folder?.trim() || inbox.folder;
    const name = input.name?.trim() || `${day(deps.now ?? new Date())} ${inbox.prefix}`;
    const { path } = await (deps.save ?? liveSave)({
        vaultRoot: root,
        relativeDir: folder,
        baseName: name,
        content: `${input.text.trim()}\n`,
    });
    logger.info({ folder, name }, "vault: appended to a note");
    return { note: relative(root, path) };
}

const VIDEO = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch|shorts|live)|youtu\.be\/)/i;

function titleOf(markdown: string): string | null {
    const front = markdown.match(/^title:\s*(.+)$/m)?.[1] ?? markdown.match(/^#\s+(.+)$/m)?.[1];
    return front?.trim().replace(/^["']|["']$/g, "") ?? null;
}

/** Clips a link into the inbox note: a page as Markdown, a video as a queued transcription. */
export async function clipToVault(input: VaultClipInput, deps: VaultDeps = {}): Promise<VaultClipReceiptDto> {
    const run = deps.run ?? ((args: string[]) => execTool(args, { timeout: 90_000, maxOutputBytes: 512 * 1024 }));
    const url = input.url.trim();
    const lead = input.note?.trim() ? `${input.note.trim()}\n\n` : "";
    const stamp = (deps.now ?? new Date()).toISOString();

    if (!/^https?:\/\//i.test(url)) {
        return { kind: "page", note: null, title: null, error: "Only http and https links can be clipped." };
    }

    if (VIDEO.test(url)) {
        const queued = await run(["youtube", "queue", "add", url]);

        if (queued.exitCode !== 0) {
            return {
                kind: "video",
                note: null,
                title: null,
                error: queued.stderr.trim().split("\n").at(-1) ?? "queue failed",
            };
        }

        const { note } = await appendToVault(
            { text: `## Video ${url}\n\n${lead}Queued for transcription ${stamp}.\n` },
            deps
        );
        return { kind: "video", note, title: null, error: null };
    }

    const fetched = await run(["fetch", url, "--depth", "advanced", "--tokens", "6000"]);

    if (fetched.exitCode !== 0) {
        return {
            kind: "page",
            note: null,
            title: null,
            error: fetched.stderr.trim().split("\n").at(-1) ?? "fetch failed",
        };
    }

    const title = titleOf(fetched.stdout);
    const { note } = await appendToVault(
        { text: `## ${title ?? url}\n\nSource: ${url} (clipped ${stamp})\n\n${lead}${fetched.stdout.trim()}\n` },
        deps
    );
    return { kind: "page", note, title, error: null };
}
