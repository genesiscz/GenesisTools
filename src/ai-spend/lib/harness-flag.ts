import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * `--harness` picks transcript data by the agent that wrote it (AI usage design 2026-11-01, section 5). The older
 * spellings stay, with the same values and the same meaning: `--sources` on the reports and `series`, `--backend`
 * on `workers`.
 */
export function addHarnessOption(command: Command, legacy: string): Command {
    return command.option("--harness <ids>", `Only the transcripts these agents wrote; same values as ${legacy}`);
}

export interface HarnessFlag {
    /** The flag the value came from, for a diagnostic that names what the user typed. */
    flag: string;
    raw: string | undefined;
}

/**
 * The one list `--harness` and its older spelling give. `null` means both were given with different lists: the
 * diagnostic is printed and `process.exitCode` set, so the action returns.
 */
export function resolveHarnessFlag({
    harness,
    legacy,
    legacyFlag,
}: {
    harness: string | undefined;
    legacy: string | undefined;
    legacyFlag: string;
}): HarnessFlag | null {
    if (harness !== undefined && legacy !== undefined && harness.trim() !== legacy.trim()) {
        out.error(`--harness ${harness} and ${legacyFlag} ${legacy} name different lists; pass one of them.`);
        process.exitCode = 1;

        return null;
    }

    if (harness !== undefined) {
        return { flag: "--harness", raw: harness };
    }

    return { flag: legacyFlag, raw: legacy };
}
