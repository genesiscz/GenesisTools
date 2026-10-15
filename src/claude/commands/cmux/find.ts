import { type FindOutcome, findInTranscript, type TranscriptIO } from "@app/claude/lib/cmux/transcript-find";
import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { activateApp, focusTarget } from "./focus";
import { locatePane } from "./read";

const { log } = logger.scoped("claude-cmux-find");

export interface FindOptions {
    decision?: string;
    oldest?: boolean;
    activate?: boolean;
    first?: boolean;
    includeSelf?: boolean;
}

const MISSES: Record<Exclude<FindOutcome, { found: true }>["reason"], string> = {
    "no-transcript": "the transcript view did not open (a dialog may hold the keys); nothing was typed",
    "no-search-bar": "the transcript search bar did not open",
    "no-match": "the transcript has no such text",
    "no-result": "the search showed no result in time",
};

function needle(text: string | undefined, decision: string | undefined): string {
    if (decision !== undefined) {
        if (!/^\d{1,6}$/.test(decision)) {
            throw new Error(`--decision must be a number (got "${decision}")`);
        }

        return `DECISION ${decision}`;
    }

    if (!text?.trim()) {
        throw new Error("pass the text to find, or --decision <n>");
    }

    return text.trim();
}

/**
 * Searches the session's transcript view while its tab stays where it is, and raises the tab only
 * after a hit, so a miss never moves the user's cmux view.
 */
export async function findCommand(session: string, text: string | undefined, opts: FindOptions): Promise<void> {
    try {
        const query = needle(text, opts.decision);
        // A decision is found where it was first asked; a re-ask further down only names it.
        const oldest = opts.oldest ?? opts.decision !== undefined;
        const located = await locatePane(session, { first: opts.first, includeSelf: opts.includeSelf }, {});

        if (!located) {
            return;
        }

        const where = surfaceTargetArgs(located.surfaceId, located.target.workspaceId);
        const io: TranscriptIO = {
            screen: async () => (await runCmuxOk(["read-screen", ...where])).stdout,
            key: async (name) => {
                await runCmuxOk(["send-key", ...where, name]);
            },
            text: async (value) => {
                await runCmuxOk(["send", ...where, "--", value]);
            },
            sleep: (ms) => Bun.sleep(ms),
        };
        const outcome = await findInTranscript(io, { query, oldest });
        log.debug({ session, query, oldest, surface: located.surfaceId, outcome }, "transcript search");

        if (!outcome.found) {
            out.error(pc.red(`"${query}" not shown: ${MISSES[outcome.reason]}.`));
            process.exitCode = 1;
            return;
        }

        await focusTarget({ ...located.target, surfaceId: located.surfaceId });

        if (opts.activate !== false) {
            await activateApp();
        }

        out.println(
            `${pc.green("✓")} "${query}" match ${outcome.current}/${outcome.total} in ${located.target.workspaceName}` +
                pc.dim(" (q or Esc leaves the transcript view, n/N steps through matches)")
        );
    } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
