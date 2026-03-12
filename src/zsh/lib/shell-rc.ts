import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export async function installHook(rcPath: string, hookMode: "static" | "dynamic"): Promise<void> {
    let updated = existsSync(rcPath) ? await Bun.file(rcPath).text() : "";

    if (updated.includes(MARKER_START)) {
        await uninstallHook(rcPath);
        updated = await Bun.file(rcPath).text();
    }
    const sourceLine =
        hookMode === "static"
            ? '[ -f ~/.genesis-tools/zsh/hook.sh ] && source ~/.genesis-tools/zsh/hook.sh'
            : 'eval "$(tools zsh hook 2>/dev/null)"';

    const block = `\n${MARKER_START}\n${sourceLine}\n${MARKER_END}\n`;
    await Bun.write(rcPath, updated + block);
}

export async function uninstallHook(rcPath: string): Promise<void> {
    if (!existsSync(rcPath)) {
        return;
    }

    const content = await Bun.file(rcPath).text();
    const startIdx = content.indexOf(MARKER_START);

    if (startIdx === -1) {
        return;
    }

    const endIdx = content.indexOf(MARKER_END, startIdx);

    if (endIdx === -1) {
        const nextLineEnd = content.indexOf("\n", startIdx);
        const hookLineEnd = nextLineEnd === -1 ? content.length : content.indexOf("\n", nextLineEnd + 1);
        const before = content.slice(0, startIdx === 0 ? 0 : startIdx - 1);
        const after = hookLineEnd === -1 || hookLineEnd >= content.length ? "" : content.slice(hookLineEnd + 1);
        await Bun.write(rcPath, before + (after ? "\n" + after : ""));
        return;
    }

    const endLineEnd = content.indexOf("\n", endIdx);
    const before = content.slice(0, startIdx === 0 ? 0 : startIdx - 1);
    const after = endLineEnd === -1 ? "" : content.slice(endLineEnd + 1);

    const cleaned = before + (after ? "\n" + after : "");
    await Bun.write(rcPath, cleaned);
}