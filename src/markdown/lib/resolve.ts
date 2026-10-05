import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type BackupRecord, backupAndWrite } from "@app/markdown/lib/backup";
import { logger } from "@genesiscz/utils/logger";
import {
    type CodeLinksResult,
    codeLinksToTokens,
    collapseIncludes,
    type IncludeOutcome,
    resolveIncludes,
} from "@genesiscz/utils/markdown/includes";

export interface ResolveFileOptions {
    file: string;
    /** Relative token paths resolve from here; default the file's folder. */
    cwd?: string;
    newOnly?: boolean;
    convertLinks?: boolean;
    /** Lines an excerpt shows from a single-line link. */
    context: number;
    dryRun: boolean;
    /** The run folder, created on first use. */
    runDir: () => string;
}

export interface ResolveFileResult {
    status: "written" | "unchanged" | "refused";
    /** Why a file was refused. */
    reason?: string;
    converted: CodeLinksResult | null;
    outcomes: IncludeOutcome[];
    /** Set when the file (or, in a dry run, its proposal) was written. */
    record?: BackupRecord;
}

function count(outcomes: IncludeOutcome[], action: IncludeOutcome["action"]): number {
    return outcomes.filter((outcome) => outcome.action === action).length;
}

/**
 * Resolves the tokens of one markdown file and writes the result through `backupAndWrite`. The only
 * change a run may make is tokens to blocks (and, with `convertLinks`, token lines added under
 * paragraphs): collapsing every block back to its token must give the text the run started from.
 */
export async function resolveMarkdownFile(options: ResolveFileOptions): Promise<ResolveFileResult> {
    const { file } = options;
    const before = readFileSync(file, "utf8");
    const converted = options.convertLinks ? codeLinksToTokens(before, { context: options.context }) : null;
    const start = converted?.text ?? before;
    const resolved = await resolveIncludes(start, {
        cwd: options.cwd ? resolve(options.cwd) : dirname(file),
        refresh: !options.newOnly,
    });
    const after = resolved.text;
    const outcomes = resolved.outcomes;

    if (collapseIncludes(after) !== collapseIncludes(start)) {
        logger.error(
            { file },
            "markdown: the result differs from the input outside the include blocks; nothing written"
        );
        return {
            status: "refused",
            reason: "the result differs outside the include blocks",
            converted,
            outcomes,
        };
    }

    if (after === before) {
        return { status: "unchanged", converted, outcomes };
    }

    try {
        const record = await backupAndWrite({
            file,
            before,
            after,
            runDir: options.runDir(),
            dryRun: options.dryRun,
            detail: {
                linksConverted: converted?.inserted.length ?? 0,
                added: count(outcomes, "added"),
                refreshed: count(outcomes, "refreshed"),
                unchanged: count(outcomes, "unchanged"),
                failed: count(outcomes, "failed"),
                skipped: count(outcomes, "skipped"),
            },
        });
        return { status: "written", converted, outcomes, record };
    } catch (error) {
        logger.error({ err: error, file }, "markdown: write refused");
        return {
            status: "refused",
            reason: error instanceof Error ? error.message : String(error),
            converted,
            outcomes,
        };
    }
}
