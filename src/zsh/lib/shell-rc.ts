import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { atomicWriteFileSync, readFileIfExistsSync } from "@genesiscz/utils/storage/atomic-file";

const MARKER_START = "# GenesisTools shell hook";
const MARKER_END = "# /GenesisTools shell hook";

const RC_CANDIDATES = [".zshrc", ".bashrc", ".bash_profile"];

export function getShellRcPaths(): string[] {
    const home = homedir();
    return RC_CANDIDATES.map((name) => join(home, name)).filter((p) => existsSync(p));
}

export async function isInstalled(rcPath: string): Promise<boolean> {
    if (!existsSync(rcPath)) {
        return false;
    }

    const content = await Bun.file(rcPath).text();
    return content.includes(MARKER_START);
}

/** The rc file's text, or `undefined` when it does not exist. Any other read error throws. */
function readRc(rcPath: string): string | undefined {
    const bytes = readFileIfExistsSync(rcPath);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
}

/**
 * Replace the user's rc file in one atomic step. It is often a symlink into a dotfiles repo, which the
 * atomic writer writes through, and the replaced text is kept as `<rc>.bak`. An rc that changed since it
 * was read (an editor, another installer) is refused rather than overwritten.
 */
function replaceRc(rcPath: string, before: string | undefined, after: string): void {
    if (before === after) {
        return;
    }

    if (readRc(rcPath) !== before) {
        throw new Error(`${rcPath} changed while the shell hook was being written. It was left untouched; run again.`);
    }

    atomicWriteFileSync(rcPath, after, { backup: true });
}

/** The text without the GenesisTools block, or without the bare hook line an install with no end marker left. */
function stripHook(content: string): string {
    const startIdx = content.indexOf(MARKER_START);

    if (startIdx === -1) {
        return content;
    }

    const before = content.slice(0, startIdx === 0 ? 0 : startIdx - 1);
    const endIdx = content.indexOf(MARKER_END, startIdx);

    if (endIdx === -1) {
        const nextLineEnd = content.indexOf("\n", startIdx);
        const hookLineEnd = nextLineEnd === -1 ? content.length : content.indexOf("\n", nextLineEnd + 1);
        const after = hookLineEnd === -1 || hookLineEnd >= content.length ? "" : content.slice(hookLineEnd + 1);
        return before + (after ? `\n${after}` : "");
    }

    const endLineEnd = content.indexOf("\n", endIdx);
    const after = endLineEnd === -1 ? "" : content.slice(endLineEnd + 1);

    return before + (after ? `\n${after}` : "");
}

/** A reinstall replaces the old block in the same single write, so the rc is never left without the hook. */
export async function installHook(rcPath: string, hookMode: "static" | "dynamic"): Promise<void> {
    const before = readRc(rcPath);
    const sourceLine =
        hookMode === "static"
            ? "[ -f ~/.genesis-tools/zsh/hook.sh ] && source ~/.genesis-tools/zsh/hook.sh"
            : `eval "$(${toolCommand("zsh hook")} 2>/dev/null)"`;

    const block = `\n${MARKER_START}\n${sourceLine}\n${MARKER_END}\n`;
    replaceRc(rcPath, before, stripHook(before ?? "") + block);
}

export async function uninstallHook(rcPath: string): Promise<void> {
    const before = readRc(rcPath);

    if (before === undefined) {
        return;
    }

    replaceRc(rcPath, before, stripHook(before));
}
