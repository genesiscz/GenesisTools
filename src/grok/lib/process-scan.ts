/**
 * Which `ps` lines are a grok process, and what kind.
 *
 * Grok spawns the same `grok` binary for both doors: the interactive TUI from
 * `tools grok run`, and one blocking child per headless turn. The prompt flag is what tells
 * them apart — a headless turn always carries the brief as `-p` or `--prompt-file`
 * (`promptArgs` in `src/grok/lib/worker.ts`), and a TUI never does, because a person types
 * into it. `--resume` is on both, so it cannot be the signal.
 */
export type GrokProcessKind = "tui" | "worker";

const PROMPT_FLAGS = new Set(["-p", "--prompt", "--prompt-file"]);

export function classifyGrokArgs(args: string): GrokProcessKind | null {
    const tokens = args.split(/\s+/);
    const base = (tokens[0] ?? "").split("/").pop() ?? "";

    if (base !== "grok") {
        return null;
    }

    return tokens.some((token) => PROMPT_FLAGS.has(token)) ? "worker" : "tui";
}
