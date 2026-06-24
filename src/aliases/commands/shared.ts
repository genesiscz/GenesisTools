import type { Command } from "commander";

export function addScanFlags(cmd: Command): Command {
    return cmd
        .option("--history <file>", "Path to a history file (default: auto-detect zsh/bash)")
        .option("--min-n <n>", "Minimum n-gram length", "1")
        .option("--max-n <n>", "Maximum n-gram length", "4")
        .option("-t, --threshold <n>", "Minimum occurrences for a single command to be hot", "3")
        .option("--chain-threshold <n>", "Minimum occurrences for a 2+ command chain to be hot", "2")
        .option("--top <n>", "Show at most N hot paths", "20")
        .option("--no-state", "Pure scan: do not read/update alias-level state")
        .option("--json", "Emit the full report as JSON to stdout");
}
