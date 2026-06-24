import { addScanFlags } from "@app/aliases/commands/shared";
import {
    type AnalyzeFlags,
    parseParams,
    renderHuman,
    resolveHistoryFile,
    runAnalysis,
} from "@app/aliases/lib/analysis";
import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";

async function analyzeAction(flags: AnalyzeFlags): Promise<void> {
    const historyFile = resolveHistoryFile(flags.history);
    if (!historyFile) {
        out.error("No history file found. Pass --history <file> (tried $HISTFILE, ~/.zsh_history, ~/.bash_history).");
        process.exitCode = 1;
        return;
    }

    const report = await runAnalysis({
        historyFile,
        params: parseParams(flags),
        noState: flags.state === false,
        now: Date.now(),
    });

    if (flags.json) {
        out.result(SafeJSON.stringify(report, null, 2));
        return;
    }

    out.result(renderHuman(report, 2));
}

export function registerAnalyzeCommand(program: Command): void {
    addScanFlags(
        program
            .command("analyze", { isDefault: true })
            .description("Mine history, show hot sequences + suggested aliases, scored")
    ).action(analyzeAction);
}
