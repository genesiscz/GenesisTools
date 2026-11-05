import { readTerminalApp } from "@genesiscz/utils/agent/identity/terminal";
import { readCmuxBundleId } from "@genesiscz/utils/cmux/caller-enricher";
import { env } from "@genesiscz/utils/env";

/**
 * The display name of the terminal application an environment runs in: cmux by its bundle id first (cmux sets
 * TERM_PROGRAM=""), then the terminal app's program, both read by their one reader (the cmux folder and the identity's
 * terminal app reader).
 */
export function detectTerminalApp(environment: NodeJS.ProcessEnv = env.getProcessEnv()): string {
    if (readCmuxBundleId(environment)) {
        return "cmux";
    }

    const tp = readTerminalApp(environment)?.program ?? "";

    switch (tp) {
        case "iTerm.app":
        case "iTerm2":
            return "iTerm";
        case "Apple_Terminal":
            return "Terminal";
        case "WarpTerminal":
            return "Warp";
        case "vscode":
        case "vscode-insiders":
            return "Visual Studio Code";
        case "ghostty":
            return "Ghostty";
        case "tmux":
            return "tmux (and your outer terminal)";
        default:
            return tp || "your terminal app";
    }
}
