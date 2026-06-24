import { existsSync } from "node:fs";
import { addScanFlags } from "@app/aliases/commands/shared";
import {
    type ApplyFlags,
    BLOCK_END,
    BLOCK_START,
    defaultRcFile,
    escapeForSingleQuote,
    parseParams,
    resolveHistoryFile,
    runAnalysis,
} from "@app/aliases/lib/analysis";
import { isWorthAliasing, upsertManagedBlock } from "@app/aliases/lib/core";
import { logger, out } from "@app/logger";
import type { Command } from "commander";

async function applyAction(flags: ApplyFlags): Promise<void> {
    const historyFile = resolveHistoryFile(flags.history);
    if (!historyFile) {
        out.error("No history file found. Pass --history <file>.");
        process.exitCode = 1;
        return;
    }

    const minLevelRaw = flags.minLevel ?? "2";
    const minLevel = Number.parseFloat(minLevelRaw);
    if (!Number.isFinite(minLevel) || minLevel < 0) {
        out.error(`Invalid --min-level "${minLevelRaw}". Expected a non-negative number.`);
        process.exitCode = 1;
        return;
    }

    const report = await runAnalysis({
        historyFile,
        params: parseParams(flags),
        noState: flags.state === false,
        now: Date.now(),
    });

    const chosen = report.paths.filter(
        (p) => p.level >= minLevel && isWorthAliasing({ commands: p.commands, aliasName: p.alias.name })
    );
    const blockBody = chosen.map((p) => `alias ${p.alias.name}='${escapeForSingleQuote(p.alias.command)}'`).join("\n");

    if (flags.print) {
        const block =
            blockBody.length > 0 ? `${BLOCK_START}\n${blockBody}\n${BLOCK_END}` : `${BLOCK_START}\n${BLOCK_END}`;
        out.result(block);
        return;
    }

    const rcFile = flags.rc ?? defaultRcFile();
    const current = existsSync(rcFile) ? await Bun.file(rcFile).text() : "";
    const updated = upsertManagedBlock(current, blockBody);
    await Bun.write(rcFile, updated);
    logger.debug({ rcFile, aliases: chosen.length }, "aliases: wrote managed block");
    out.log.success(`Wrote ${chosen.length} alias(es) to the managed block in ${rcFile}`);
}

export function registerApplyCommand(program: Command): void {
    addScanFlags(program.command("apply").description("Write suggested aliases into the managed rc block (or print)"))
        .option("--rc <file>", "Target rc file (default: auto-detect ~/.zshrc or ~/.bashrc)")
        .option("--min-level <n>", "Only emit paths whose alias level >= n", "2")
        .option("--print", "Print the alias block to stdout instead of writing the rc")
        .action(applyAction);
}
