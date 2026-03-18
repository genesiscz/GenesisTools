/**
 * Detect the name of the current terminal application.
 * Checks CMUX_BUNDLE_ID first (cmux sets TERM_PROGRAM="" but has its own env),
 * then falls back to TERM_PROGRAM.
 */
export function detectTerminalApp(): string {
    if (process.env.CMUX_BUNDLE_ID) {
        return "cmux";
    }

    const tp = process.env.TERM_PROGRAM ?? "";

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
