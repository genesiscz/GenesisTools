/**
 * Which `ps` lines are a codex process, and what kind.
 *
 * `tools codex run` launches the real `codex` binary against a local app-server; a headless
 * worker is a detached `bun .../codex/daemon.ts --name <n>` which starts its own app-server.
 * The TUI is the billable session; the other two are its machinery, so `who` hides them
 * unless asked.
 */
export type CodexProcessKind = "tui" | "app-server" | "daemon";

export const CODEX_HELPER_KINDS = ["app-server", "daemon"] as const;

export function classifyCodexArgs(args: string): CodexProcessKind | null {
    const tokens = args.split(/\s+/);
    const base = (tokens[0] ?? "").split("/").pop() ?? "";

    if (base === "codex") {
        return tokens.includes("app-server") ? "app-server" : "tui";
    }

    // The daemon is `<bun> <repo>/src/codex/daemon.ts --name <n>`; the entry path is what
    // tells it apart from every other bun process on the machine.
    if (tokens.some((token) => token.endsWith("/codex/daemon.ts"))) {
        return "daemon";
    }

    return null;
}
