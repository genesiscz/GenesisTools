import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER_START = "# GenesisTools shell hook";
const MARKER_END = "# /GenesisTools shell hook";

const RC_CANDIDATES = [".zshrc", ".bashrc", ".bash_profile"];

export function getShellRcPaths(): string[] {
    const home = homedir();
    return RC_CANDIDATES.map((name) => join(home, name)).filter((p) => existsSync(p));
}

export function isInstalled(rcPath: string): boolean {
    if (!existsSync(rcPath)) {
        return false;
    }

    const content = readFileSync(rcPath, "utf-8");
    return content.includes(MARKER_START);
}

export function installHook(rcPath: string, hookMode: "static" | "dynamic"): void {
    let updated = existsSync(rcPath) ? readFileSync(rcPath, "utf-8") : "";

    if (updated.includes(MARKER_START)) {
        uninstallHook(rcPath);
        updated = readFileSync(rcPath, "utf-8");
    }
    const sourceLine =
        hookMode === "static"
            ? '[ -f ~/.genesis-tools/zsh/hook.sh ] && source ~/.genesis-tools/zsh/hook.sh'
            : 'eval "$(tools zsh hook 2>/dev/null)"';

    const block = `\n${MARKER_START}\n${sourceLine}\n${MARKER_END}\n`;
    writeFileSync(rcPath, updated + block);
}

export function uninstallHook(rcPath: string): void {
    if (!existsSync(rcPath)) {
        return;
    }

    const content = readFileSync(rcPath, "utf-8");
    const startIdx = content.indexOf(MARKER_START);

    if (startIdx === -1) {
        return;
    }

    const endIdx = content.indexOf(MARKER_END);

    if (endIdx === -1) {
        // Corrupted: start marker without end marker — remove from start marker to next newline
        const lineEnd = content.indexOf("\n", startIdx);
        const before = content.slice(0, startIdx === 0 ? 0 : startIdx - 1);
        const after = lineEnd === -1 ? "" : content.slice(lineEnd + 1);
        writeFileSync(rcPath, before + (after ? "\n" + after : ""));
        return;
    }

    const endLineEnd = content.indexOf("\n", endIdx);
    const before = content.slice(0, startIdx === 0 ? 0 : startIdx - 1);
    const after = endLineEnd === -1 ? "" : content.slice(endLineEnd + 1);

    const cleaned = before + (after ? "\n" + after : "");
    writeFileSync(rcPath, cleaned);
}
